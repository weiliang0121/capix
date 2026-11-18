import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { githubRelease } from '../../scripts/release/github-release.mjs';

const repository = 'example/capix';
const source = 'a'.repeat(40);
const other = 'b'.repeat(40);
const tag = 'release/pr-42';
const ref = `refs/tags/${tag}`;
const notes = '# CAPiX release\n\nChanges in this release.\n';
const manifestName = 'release-manifest.json';
const packageEntry = { name: '@weiliang0121/capix-tool', version: '0.11.0', file: 'weiliang0121-capix-tool-0.11.0.tgz', integrity: `sha512-${createHash('sha512').update('test package').digest('base64')}` };
const asset = { id: 8, name: manifestName, state: 'uploaded' };

function remoteRelease(overrides = {}) {
  return { id: 7, tag_name: tag, target_commitish: source, name: `${packageEntry.name}@${packageEntry.version}`, body: notes, draft: true, prerelease: false, assets: [], ...overrides };
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-github-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { schemaVersion: 1, source, pullRequest: 42, packages: [packageEntry], ...overrides };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, manifestName), bytes);
  await writeFile(join(directory, 'release-notes.md'), notes);
  return { directory, manifest, bytes };
}

function mockRemote(overrides = {}) {
  const state = { refs: [], releases: [], annotatedTags: new Map(), writes: [], assets: new Map(), ...overrides };
  const result = (data) => Buffer.from(JSON.stringify(data));
  function run(args, body) {
    if (args[0] === 'release') {
      assert.deepEqual(args.slice(0, 3), ['release', 'upload', tag]);
      assert.equal(basename(args[3]), manifestName);
      assert.deepEqual(args.slice(4), ['--repo', `github.com/${repository}`]);
      const release = state.releases.find((entry) => entry.tag_name === tag);
      assert.ok(release.draft);
      assert.deepEqual(release.assets, []);
      state.writes.push('upload manifest');
      state.assets.set(asset.id, state.uploadBytes ?? readFileSync(args[3]));
      release.assets.push(asset);
      if (state.afterUpload) state.afterUpload();
      return Buffer.alloc(0);
    }
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    const endpoint = args[3];
    const prefix = `repos/${repository}/`;
    assert.ok(endpoint.startsWith(prefix));
    const path = endpoint.slice(prefix.length);
    if (path === `git/matching-refs/tags/${tag}`) return result(state.refs);
    if (path.startsWith('git/tags/')) return result(state.annotatedTags.get(path.slice('git/tags/'.length)));
    if (path === 'releases?per_page=100') {
      assert.deepEqual(args.slice(4), ['--paginate', '--slurp']);
      return result([[], state.releases]);
    }
    if (path === `releases/assets/${asset.id}`) {
      assert.deepEqual(args.slice(4), ['--header', 'Accept: application/octet-stream']);
      return state.assets.get(asset.id);
    }
    const method = args[5];
    assert.deepEqual(args.slice(4), ['--method', method, '--header', 'Content-Type: application/json', '--input', '-']);
    if (path === 'git/refs' && method === 'POST') {
      assert.deepEqual(body, { ref, sha: source });
      assert.equal(
        state.refs.some((entry) => entry.ref === ref),
        false,
      );
      state.writes.push('create tag');
      const installed = { ref, object: { type: 'commit', sha: source } };
      state.refs.push(installed);
      return result(installed);
    }
    if (path === 'releases' && method === 'POST') {
      assert.deepEqual(body, { tag_name: tag, target_commitish: source, name: state.title ?? `${packageEntry.name}@${packageEntry.version}`, body: notes, draft: true, prerelease: false, make_latest: 'legacy' });
      assert.equal(
        state.releases.some((entry) => entry.tag_name === tag),
        false,
      );
      const release = remoteRelease({ name: body.name });
      state.releases.push(release);
      state.writes.push('create draft');
      return result(release);
    }
    if (path === 'releases/7' && method === 'PATCH') {
      assert.deepEqual(body, { draft: false, make_latest: 'legacy' });
      const release = state.releases.find((entry) => entry.id === 7);
      assert.deepEqual(release.assets, [asset]);
      state.writes.push('publish release');
      release.draft = false;
      return result(release);
    }
    assert.fail(`Unexpected GitHub request: ${args.join(' ')}`);
  }
  return { state, run };
}

test('makes the fixed tag and verified release, and treats a matching rerun as read-only', async (t) => {
  const { directory } = await fixture(t);
  const prefixMatch = { ref: `${ref}0`, object: { type: 'commit', sha: other } };
  const { state, run } = mockRemote({ refs: [prefixMatch] });
  assert.deepEqual(await githubRelease(directory, repository, run), { tag, published: true });
  assert.deepEqual(state.writes, ['create tag', 'create draft', 'upload manifest', 'publish release']);
  state.writes.length = 0;
  assert.deepEqual(await githubRelease(directory, repository, run), { tag, published: false });
  assert.deepEqual(state.writes, []);
});

test('groups a multi-package release by PR and resumes a draft after a tag is created', async (t) => {
  const { directory, bytes } = await fixture(t, { packages: [packageEntry, { ...packageEntry, name: '@weiliang0121/capix-contracts', file: 'contracts.tgz' }] });
  const title = 'CAPiX release (PR #42)';
  const annotated = { sha: other, object: { type: 'commit', sha: source } };
  const { state, run } = mockRemote({ title, refs: [{ ref, object: { type: 'tag', sha: other } }], annotatedTags: new Map([[other, annotated]]), uploadBytes: bytes });
  assert.deepEqual(await githubRelease(directory, repository, run), { tag, published: true });
  assert.deepEqual(state.writes, ['create draft', 'upload manifest', 'publish release']);
});

test('fills an existing draft after a manifest upload response was lost', async (t) => {
  const { directory, bytes } = await fixture(t);
  const interrupted = new Error('Upload response was lost');
  const { state, run } = mockRemote({
    refs: [{ ref, object: { type: 'commit', sha: source } }],
    releases: [remoteRelease()],
    uploadBytes: bytes,
    afterUpload: () => {
      throw interrupted;
    },
  });
  await assert.rejects(githubRelease(directory, repository, run), (error) => error === interrupted);
  assert.deepEqual(state.writes, ['upload manifest']);
  assert.deepEqual(await githubRelease(directory, repository, run), { tag, published: true });
  assert.deepEqual(state.writes, ['upload manifest', 'publish release']);
});

test('rejects conflicts before writing to the repository', async (t) => {
  const { directory, bytes } = await fixture(t);
  const refs = [{ ref, object: { type: 'commit', sha: source } }];
  const assets = new Map([[asset.id, bytes]]);
  for (const [overrides, message] of [
    [{ refs: [{ ref, object: { type: 'commit', sha: other } }] }, /differs from the prepared source/],
    [{ refs: [], releases: [remoteRelease()] }, /differs from the prepared source/],
    [{ releases: [remoteRelease(), remoteRelease({ id: 9 })] }, /Multiple GitHub Releases/],
    [{ releases: [remoteRelease({ name: 'Conflicting release' })] }, /title differs/],
    [{ releases: [remoteRelease({ body: '# Conflicting notes', draft: false })] }, /notes differ/],
    [{ releases: [remoteRelease({ assets: [{ ...asset, name: 'unknown.tgz' }] })] }, /Unexpected GitHub Release assets/],
    [{ releases: [remoteRelease({ assets: [{ ...asset, state: 'starter' }] })] }, /Unexpected GitHub Release manifest asset state/],
    [{ releases: [remoteRelease({ draft: false })] }, /missing its manifest/],
    [{ releases: [remoteRelease({ draft: false, assets: [asset] })], assets: new Map([[asset.id, Buffer.from('{}\n')]]) }, /manifest differs/],
  ]) {
    const { state, run } = mockRemote({ refs, assets, ...overrides });
    await assert.rejects(githubRelease(directory, repository, run), message);
    assert.deepEqual(state.writes, []);
  }
});

test('verifies uploaded bytes and the immutable tag before publishing a draft', async (t) => {
  const { directory, bytes } = await fixture(t);
  const { state, run } = mockRemote({ uploadBytes: Buffer.from('{}\n') });
  await assert.rejects(githubRelease(directory, repository, run), /manifest differs/);
  assert.deepEqual(state.writes, ['create tag', 'create draft', 'upload manifest']);
  const changed = mockRemote({
    uploadBytes: bytes,
    afterUpload: () => {
      changed.state.refs[0].object.sha = other;
    },
  });
  await assert.rejects(githubRelease(directory, repository, changed.run), /tag release\/pr-42 changed/);
  assert.deepEqual(changed.state.writes, ['create tag', 'create draft', 'upload manifest']);
});

test('rejects invalid evidence before invoking gh', async (t) => {
  const { directory, manifest } = await fixture(t);
  const run = () => assert.fail('Invalid artifacts must not cause GitHub requests');
  for (const [overrides, message] of [
    [{ schemaVersion: 2 }, /Unsupported GitHub release manifest/],
    [{ source: 'abc' }, /full source commit SHA/],
    [{ pullRequest: 0 }, /positive pull request number/],
    [{ packages: [] }, /at least one published package/],
    [{ packages: [null] }, /public CAPiX package name/],
    [{ packages: [{ ...packageEntry, version: '0.11.0-rc.1' }] }, /Invalid release version/],
    [{ packages: [{ ...packageEntry, file: '../package.tgz' }] }, /Invalid archive filename/],
    [{ packages: [{ ...packageEntry, integrity: 'sha512-invalid' }] }, /Invalid npm integrity/],
    [{ packages: [packageEntry, { ...packageEntry, version: '0.11.1' }] }, /Duplicate package or archive/],
  ]) {
    await writeFile(join(directory, manifestName), JSON.stringify({ ...manifest, ...overrides }));
    await assert.rejects(githubRelease(directory, repository, run), message);
  }
  await writeFile(join(directory, manifestName), JSON.stringify(manifest));
  await assert.rejects(githubRelease(directory, '../../capix', run), /GITHUB_REPOSITORY/);
  const notesPath = join(directory, 'release-notes.md');
  await writeFile(notesPath, ' ');
  await assert.rejects(githubRelease(directory, repository, run), /nonempty release-notes/);
  await rm(notesPath);
  await symlink(join(directory, manifestName), notesPath);
  await assert.rejects(githubRelease(directory, repository, run), /regular file/);
});
