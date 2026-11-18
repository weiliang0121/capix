import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from './packages.mjs';

const manifestName = 'release-manifest.json';
const commitSha = /^[0-9a-f]{40}$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function runGh(args, body) {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  delete env.GH_DEBUG;
  const input = body === undefined ? undefined : JSON.stringify(body);
  return command('gh', args, { input, env, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
}

async function readArtifact(directory, name) {
  const path = join(directory, name);
  assert.ok((await lstat(path)).isFile(), `${name} must be a regular file`);
  return readFile(path);
}

function readManifest(bytes) {
  const manifest = JSON.parse(utf8.decode(bytes));
  assert.equal(manifest?.schemaVersion, 1, 'Unsupported GitHub release manifest');
  assert.ok(typeof manifest.source === 'string' && commitSha.test(manifest.source), 'Expected a full source commit SHA');
  assert.ok(Number.isSafeInteger(manifest.pullRequest) && manifest.pullRequest > 0, 'Expected a positive pull request number');
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'Expected at least one published package');
  const names = new Set();
  const files = new Set();
  for (const entry of manifest.packages) {
    assert.ok(typeof entry?.name === 'string' && /^@weiliang0121\/capix-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name), 'Expected a public CAPiX package name');
    assert.ok(typeof entry.version === 'string' && stableVersion.test(entry.version), `Invalid release version for ${entry.name}`);
    assert.ok(typeof entry.file === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(entry.file), `Invalid archive filename for ${entry.name}`);
    assert.ok(typeof entry.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity), `Invalid npm integrity for ${entry.name}`);
    const digest = Buffer.from(entry.integrity.slice('sha512-'.length), 'base64');
    assert.equal(`sha512-${digest.toString('base64')}`, entry.integrity, `Non-canonical npm integrity for ${entry.name}`);
    assert.ok(!names.has(entry.name) && !files.has(entry.file), `Duplicate package or archive: ${entry.name}`);
    names.add(entry.name);
    files.add(entry.file);
  }
  return manifest;
}

function github(repository, tag, run) {
  const endpoint = `repos/${repository}`;
  const ref = `refs/tags/${tag}`;
  function api(path, args = [], body) {
    return run(['api', '--hostname', 'github.com', `${endpoint}/${path}`, ...args], body);
  }
  function get(path, args) {
    return JSON.parse(api(path, args));
  }
  function write(path, method, body) {
    return JSON.parse(api(path, ['--method', method, '--header', 'Content-Type: application/json', '--input', '-'], body));
  }
  return {
    tagTarget() {
      const refs = get(`git/matching-refs/tags/${tag}`);
      assert.ok(Array.isArray(refs) && refs.every((entry) => typeof entry?.ref === 'string'), 'Unexpected Git ref response');
      const matches = refs.filter((entry) => entry.ref === ref);
      assert.ok(matches.length <= 1, `Multiple Git refs for ${ref}`);
      if (matches.length === 0) return undefined;
      let target = matches[0].object;
      const visited = new Set();
      while (target?.type === 'tag') {
        assert.ok(typeof target.sha === 'string' && commitSha.test(target.sha) && !visited.has(target.sha) && visited.size < 16, `Invalid annotated Git tag ${tag}`);
        visited.add(target.sha);
        const annotated = get(`git/tags/${target.sha}`);
        assert.equal(annotated?.sha, target.sha, `Unexpected annotated Git tag ${tag}`);
        target = annotated.object;
      }
      assert.ok(target?.type === 'commit' && typeof target.sha === 'string' && commitSha.test(target.sha), `${ref} does not resolve to a commit`);
      return target.sha;
    },
    findRelease() {
      const pages = get('releases?per_page=100', ['--paginate', '--slurp']);
      assert.ok(Array.isArray(pages) && pages.every((page) => Array.isArray(page) && page.every((entry) => typeof entry?.tag_name === 'string')), 'Unexpected GitHub Releases listing');
      const matches = pages.flat().filter((entry) => entry.tag_name === tag);
      assert.ok(matches.length <= 1, `Multiple GitHub Releases for ${tag}`);
      return matches[0];
    },
    createTag(source) {
      write('git/refs', 'POST', { ref, sha: source });
    },
    createDraft(source, name, body) {
      write('releases', 'POST', { tag_name: tag, target_commitish: source, name, body, draft: true, prerelease: false, make_latest: 'legacy' });
    },
    readManifestAsset(id) {
      return api(`releases/assets/${id}`, ['--header', 'Accept: application/octet-stream']);
    },
    async uploadManifest(bytes) {
      const directory = await mkdtemp(join(tmpdir(), 'capix-release-manifest-'));
      try {
        const path = join(directory, manifestName);
        await writeFile(path, bytes);
        run(['release', 'upload', tag, path, '--repo', `github.com/${repository}`]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    publish(id) {
      write(`releases/${id}`, 'PATCH', { draft: false, make_latest: 'legacy' });
    },
  };
}

function checkRelease(release, title, notes, manifestBytes, remote) {
  assert.ok(release && Number.isSafeInteger(release.id) && release.id > 0 && typeof release.draft === 'boolean' && release.prerelease === false, 'Unexpected GitHub Release state');
  assert.equal(release.name, title, 'GitHub Release title differs from the prepared release');
  assert.equal(release.body, notes, 'GitHub Release notes differ from release-notes.md');
  assert.ok(Array.isArray(release.assets) && release.assets.length <= 1 && release.assets.every((asset) => asset?.name === manifestName), 'Unexpected GitHub Release assets');
  const [asset] = release.assets;
  if (!asset) return false;
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded', 'Unexpected GitHub Release manifest asset state');
  assert.ok(manifestBytes.equals(remote.readManifestAsset(asset.id)), 'GitHub Release manifest differs from release-manifest.json');
  return true;
}

export async function githubRelease(directory, repository, run = runGh) {
  assert.ok(typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) && !repository.endsWith('/.') && !repository.endsWith('/..'), 'Expected GITHUB_REPOSITORY in owner/name form');
  const manifestBytes = await readArtifact(directory, manifestName);
  const { source, pullRequest, packages } = readManifest(manifestBytes);
  const notes = utf8.decode(await readArtifact(directory, 'release-notes.md'));
  assert.ok(notes.trim(), 'Expected nonempty release-notes.md');
  const tag = `release/pr-${pullRequest}`;
  const title = packages.length === 1 ? `${packages[0].name}@${packages[0].version}` : `CAPiX release (PR #${pullRequest})`;
  const remote = github(repository, tag, run);

  const target = remote.tagTarget();
  const existing = remote.findRelease();
  if (target || existing) assert.equal(target, source, `GitHub tag ${tag} differs from the prepared source commit`);
  else {
    remote.createTag(source);
    assert.equal(remote.tagTarget(), source, `GitHub tag ${tag} could not be verified`);
  }
  if (!existing) remote.createDraft(source, title, notes);
  const release = existing ?? remote.findRelease();
  const hasManifest = checkRelease(release, title, notes, manifestBytes, remote);
  if (!release.draft) {
    assert.ok(hasManifest, 'Published GitHub Release is missing its manifest');
    assert.equal(remote.tagTarget(), source, `GitHub tag ${tag} changed during verification`);
    return { tag, published: false };
  }

  if (!hasManifest) await remote.uploadManifest(manifestBytes);
  const ready = remote.findRelease();
  assert.equal(ready?.id, release.id, 'GitHub Release changed during verification');
  assert.ok(checkRelease(ready, title, notes, manifestBytes, remote), 'GitHub Release manifest upload could not be verified');
  assert.equal(remote.tagTarget(), source, `GitHub tag ${tag} changed during verification`);
  if (!ready.draft) return { tag, published: false };
  remote.publish(ready.id);
  const published = remote.findRelease();
  assert.equal(published?.id, release.id, 'GitHub Release changed during publication');
  assert.equal(published.draft, false, 'GitHub Release is still a draft');
  assert.ok(checkRelease(published, title, notes, manifestBytes, remote), 'Published GitHub Release is missing its manifest');
  assert.equal(remote.tagTarget(), source, `GitHub tag ${tag} changed during publication`);
  return { tag, published: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/release/github-release.mjs <artifact-dir>');
    assert.ok(process.env.GH_TOKEN?.trim(), 'GH_TOKEN is required');
    const { tag, published } = await githubRelease(resolve(process.argv[2]), process.env.GITHUB_REPOSITORY);
    console.log(published ? `Published GitHub Release ${tag}` : `Verified published GitHub Release ${tag}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
