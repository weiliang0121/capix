import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { command, packages, registry } from '../../scripts/release/packages.mjs';
import { publishBatch } from '../../scripts/release/publish-batch.mjs';

async function fixture(t, selected = ['contracts', 'changes']) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'package'));
  const source = command('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const manifest = { schemaVersion: 1, source, pullRequest: 12, packages: [] };
  const workspace = new Map((await packages()).map(({ manifest }) => [manifest.name, manifest]));
  for (const key of selected) {
    const packed = workspace.get(`@weiliang0121/capix-${key}`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(packed[field] ?? {})) {
        if (workspace.has(name)) packed[field][name] = workspace.get(name).version;
      }
    }
    const { name, version } = packed;
    const file = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    await writeFile(join(directory, 'package/package.json'), JSON.stringify(packed));
    command('tar', ['-czf', file, 'package/package.json'], { cwd: directory });
    const digest = createHash('sha512')
      .update(await readFile(join(directory, file)))
      .digest('base64');
    manifest.packages.push({ name, version, file, integrity: `sha512-${digest}` });
  }
  const save = (value) => writeFile(join(directory, 'release-manifest.json'), JSON.stringify(value));
  await save(manifest);
  return { directory, manifest, save, workspace };
}

function visible(entry, integrity = entry.integrity) {
  return Response.json({ name: entry.name, 'dist-tags': { latest: entry.version }, versions: { [entry.version]: { version: entry.version, dist: { integrity } } } });
}

const missing = () => new Response(null, { status: 404 });
const offline = { sleep: () => {}, run: () => assert.fail('Unexpected npm write'), request: () => assert.fail('Unexpected registry read') };

test('publish sends each missing accepted archive once in dependency order and waits for visibility', async (t) => {
  const { directory, manifest } = await fixture(t);
  const calls = [];
  const waiting = new Set();
  const uploaded = new Set();
  await publishBatch('publish', directory, {
    ...offline,
    request: (url) => {
      const entry = manifest.packages.find(({ name }) => url === `${registry}/${encodeURIComponent(name)}`);
      assert.ok(entry);
      if (!uploaded.has(entry.name) || waiting.delete(entry.name)) return missing();
      return visible(entry);
    },
    run: (command, args) => {
      const entry = manifest.packages[calls.length];
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['publish', join(directory, entry.file), '--access=public', '--tag=latest', `--registry=${registry}`, '--provenance', '--ignore-scripts', '--fetch-retries=0']);
      calls.push(entry.name);
      waiting.add(entry.name);
      uploaded.add(entry.name);
      if (calls.length === 1) throw new Error('response lost after commit');
    },
  });
  assert.deepEqual(
    calls,
    manifest.packages.map(({ name }) => name),
  );
});

test('both modes accept existing matching versions read-only', async (t) => {
  const { directory, manifest } = await fixture(t);
  const request = (url) => visible(manifest.packages.find(({ name }) => url.endsWith(encodeURIComponent(name))));
  for (const mode of ['verify', 'publish']) await publishBatch(mode, directory, { ...offline, request });
});

test('conflicts, unreadable metadata and latest regression fail before the first write', async (t) => {
  const { directory, manifest } = await fixture(t);
  const second = manifest.packages[1];
  for (const [response, reason] of [
    [visible(second, 'another artifact'), /integrity mismatch/],
    [Response.json({ name: second.name, 'dist-tags': { latest: '9000.0.0' }, versions: {} }), /Refusing to move latest/],
    [new Response(null, { status: 503 }), /HTTP 503/],
    [Response.json({ name: second.name }), /Missing registry versions/],
  ]) {
    await assert.rejects(publishBatch('publish', directory, { ...offline, request: (url) => (url.endsWith(encodeURIComponent(second.name)) ? response : missing()) }), reason);
  }
});

test('an unknown publish result uses bounded reads and stops later writes', async (t) => {
  const { directory } = await fixture(t);
  let writes = 0;
  let sleeps = 0;
  await assert.rejects(
    publishBatch('publish', directory, {
      request: missing,
      run: () => {
        writes++;
        throw new Error('response lost');
      },
      sleep: () => sleeps++,
    }),
    /Could not confirm/,
  );
  assert.equal(writes, 1);
  assert.equal(sleeps, 5);
});

test('manifest source, inventory, order, filenames, archive digests and packed identities are checked before registry access', async (t) => {
  const { directory, manifest, save } = await fixture(t);
  const [first, second] = manifest.packages;
  for (const [changed, reason] of [
    [{ schemaVersion: 2 }, /Unsupported release manifest/],
    [{ source: '0'.repeat(40) }, /exact release commit/],
    [{ pullRequest: 0 }, /Invalid version PR/],
    [{ packages: [] }, /Empty release manifest/],
    [{ packages: [first, first] }, /Duplicate release package/],
    [{ packages: [second, first] }, /Dependency must publish first/],
    [{ packages: [{ ...first, name: '@other/name' }] }, /Unknown release package/],
    [{ packages: [{ ...first, version: '9000.0.0' }] }, /Version differs from checkout/],
    [{ packages: [{ ...first, file: '../other.tgz' }] }, /Unexpected tarball filename/],
    [{ packages: [first, { ...second, integrity: 'altered' }] }, /Artifact changed/],
  ]) {
    await save({ ...manifest, ...changed });
    await assert.rejects(publishBatch('publish', directory, offline), reason);
  }
  await writeFile(join(directory, first.file), await readFile(join(directory, second.file)));
  await save({ ...manifest, packages: [{ ...first, integrity: second.integrity }] });
  await assert.rejects(publishBatch('publish', directory, offline), /Unexpected packed package name/);
});

test('a newer latest observed just before upload stops the previously eligible package', async (t) => {
  const { directory, manifest } = await fixture(t);
  const first = manifest.packages[0];
  let reads = 0;
  await assert.rejects(
    publishBatch('publish', directory, {
      ...offline,
      request: (url) => {
        if (url.endsWith(encodeURIComponent(first.name)) && ++reads === 2) return Response.json({ name: first.name, 'dist-tags': { latest: '9000.0.0' }, versions: {} });
        return missing();
      },
    }),
    /Refusing to move latest/,
  );
});

test('an exact internal dependency outside the batch must exist before upload or release confirmation', async (t) => {
  const { directory, manifest, workspace } = await fixture(t, ['contracts', 'platform-node', 'platform', 'structure']);
  const dependency = workspace.get('@weiliang0121/capix-resources');
  const url = `${registry}/${encodeURIComponent(dependency.name)}`;
  for (const mode of ['publish', 'verify']) {
    for (const dependencyResponse of [missing(), visible({ ...dependency, version: '99.0.0' })]) {
      const request = (target) => {
        assert.equal(target, url, 'Check external prerequisites before touching the current batch');
        return dependencyResponse;
      };
      await assert.rejects(publishBatch(mode, directory, { ...offline, request }), { message: `Unpublished dependency: ${dependency.name}@${dependency.version}` });
    }
    const request = (target) => {
      if (target === url) return visible(dependency, 'previously published tarball integrity');
      return visible(manifest.packages.find(({ name }) => target.endsWith(encodeURIComponent(name))));
    };
    await publishBatch(mode, directory, { ...offline, request });
  }
});
