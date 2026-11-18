import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifiedPlan } from '../../scripts/release/plan.mjs';

test('publication uses the exact verified artifact and preserves dependency groups', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'release-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = 'verified package bytes';
  const archive = { name: '@example/contracts', version: '0.1.0', file: 'contracts.tgz', sha256: createHash('sha256').update(content).digest('hex') };
  await writeFile(join(directory, archive.file), content);
  const release = { kind: 'publish', name: archive.name, version: archive.version, access: 'public', tag: 'latest' };
  const plan = { version: 1, plan: [[release]] };
  const result = await verifiedPlan(plan, [archive], directory);
  assert.deepEqual(
    result.plan.map((group) => group.map((entry) => entry.name)),
    [[archive.name]],
  );
  assert.equal(result.plan[0][0].tarball.path, archive.file);
  assert.equal(result.plan[0][0].tarball.integrity, `sha256-${Buffer.from(archive.sha256, 'hex').toString('base64')}`);
  // Already published versions can be absent from the registry's remaining plan.
  assert.deepEqual(await verifiedPlan({ version: 1, plan: [] }, [archive], directory), { version: 1, plan: [] });
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, name: '@example/service' }]] }, [archive], directory), /Unverified package/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, version: '0.2.0' }]] }, [archive], directory), /version differs/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, access: 'restricted' }]] }, [archive], directory), /public packages/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[release, release]] }, [archive], directory), /Duplicate planned/);
  await writeFile(join(directory, archive.file), 'different package bytes');
  await assert.rejects(verifiedPlan(plan, [archive], directory), /changed after verification/);
});

test('an independent Tool release selects only its 0.8.0 artifact from an inventory containing published 0.7.0 dependencies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'release-plan-independent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archives = [];
  for (const [name, version] of [
    ['contracts', '0.7.0'],
    ['structure', '0.7.0'],
    ['tool', '0.8.0'],
  ]) {
    const content = `${name}@${version}`;
    const file = `${name}-${version}.tgz`;
    await writeFile(join(directory, file), content);
    archives.push({ name: `@weiliang0121/capix-${name}`, version, file, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const release = { kind: 'publish', name: '@weiliang0121/capix-tool', version: '0.8.0', access: 'public', tag: 'latest' };
  const selected = await verifiedPlan({ version: 1, plan: [[release]] }, archives, directory);
  assert.deepEqual(
    selected.plan.map((group) => group.map(({ name, version }) => ({ name, version }))),
    [[{ name: release.name, version: '0.8.0' }]],
  );
  assert.equal(selected.plan[0][0].tarball.path, 'tool-0.8.0.tgz');
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, version: '0.7.0' }]] }, archives, directory), /version differs/);
});
