import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { command, json, packages, registry } from './packages.mjs';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function verifiedArchive(directory, entry) {
  const archive = resolve(directory, entry.file);
  assert.ok((await lstat(archive)).isFile(), `Expected regular tarball: ${entry.file}`);
  const digest = createHash('sha512')
    .update(await readFile(archive))
    .digest('base64');
  assert.equal(`sha512-${digest}`, entry.integrity, `Artifact changed after verification: ${entry.name}`);
  return archive;
}

async function readBatch(directory) {
  const manifest = await json(join(directory, 'release-manifest.json'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported release manifest');
  assert.match(manifest.source, /^[a-f0-9]{40}$/);
  assert.equal(manifest.source, command('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(), 'Check out the exact release commit');
  assert.ok(Number.isSafeInteger(manifest.pullRequest) && manifest.pullRequest > 0, 'Invalid version PR');
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'Empty release manifest');
  const workspace = new Map((await packages()).map(({ manifest }) => [manifest.name, manifest]));
  const selected = new Set(manifest.packages.map(({ name }) => name));
  assert.equal(selected.size, manifest.packages.length, 'Duplicate release package');
  const checked = new Set();
  for (const entry of manifest.packages) {
    const local = workspace.get(entry.name);
    assert.ok(local, `Unknown release package: ${entry.name}`);
    assert.match(entry.version, stableVersion);
    assert.equal(entry.version, local.version, `Version differs from checkout: ${entry.name}`);
    assert.equal(entry.file, `${entry.name.slice(1).replace('/', '-')}-${entry.version}.tgz`, 'Unexpected tarball filename');
    for (const dependency of Object.keys({ ...local.dependencies, ...local.optionalDependencies, ...local.peerDependencies })) {
      assert.ok(!selected.has(dependency) || checked.has(dependency), `Dependency must publish first: ${dependency}`);
    }
    const archive = await verifiedArchive(directory, entry);
    const packed = JSON.parse(command('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(packed.name, entry.name, 'Unexpected packed package name');
    assert.equal(packed.version, entry.version, 'Unexpected packed package version');
    assert.deepEqual(packed.publishConfig, local.publishConfig, 'Unexpected packed publishConfig');
    checked.add(entry.name);
  }
  return manifest.packages;
}

async function readMetadata(entry, request) {
  const response = await request(`${registry}/${encodeURIComponent(entry.name)}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `Registry returned HTTP ${response.status} for ${entry.name}`);
  const metadata = await response.json();
  assert.equal(metadata.name, entry.name, 'Unexpected registry package');
  assert.ok(metadata.versions && typeof metadata.versions === 'object' && !Array.isArray(metadata.versions), 'Missing registry versions');
  return metadata;
}

function published(entry, metadata) {
  if (!metadata || !Object.hasOwn(metadata.versions, entry.version)) return false;
  assert.equal(metadata.versions[entry.version]?.dist?.integrity, entry.integrity, `Registry integrity mismatch: ${entry.name}@${entry.version}`);
  return true;
}

function allowLatest(entry, metadata) {
  if (!metadata) return;
  const latest = metadata['dist-tags']?.latest;
  assert.match(latest, stableVersion, `Missing or unsupported latest tag: ${entry.name}`);
  const current = latest.split('.').map(BigInt);
  const target = entry.version.split('.').map(BigInt);
  const different = target.findIndex((part, index) => part !== current[index]);
  assert.ok(different >= 0 && target[different] > current[different], `Refusing to move latest from ${latest} to ${entry.version}: ${entry.name}`);
}

async function waitForVersion(entry, request, sleep) {
  let lastReadError;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await sleep(5000 * attempt);
    let metadata;
    try {
      metadata = await readMetadata(entry, request);
      lastReadError = undefined;
    } catch (error) {
      lastReadError = error;
      continue;
    }
    if (published(entry, metadata)) return;
  }
  throw new Error(`Could not confirm ${entry.name}@${entry.version} in the registry`, { cause: lastReadError });
}

export async function publishBatch(mode, directory, { request = fetch, run = command, sleep = delay } = {}) {
  assert.ok(['publish', 'verify'].includes(mode), 'Expected publish or verify');
  const entries = await readBatch(directory);
  const confirmed = new Set();
  if (mode === 'publish') {
    for (const entry of entries) {
      const metadata = await readMetadata(entry, request);
      if (published(entry, metadata)) {
        console.log(`Already verified ${entry.name}@${entry.version}`);
        confirmed.add(entry.name);
      } else allowLatest(entry, metadata);
    }
  }
  for (const entry of entries.filter(({ name }) => !confirmed.has(name))) {
    if (mode === 'publish') {
      const metadata = await readMetadata(entry, request);
      if (published(entry, metadata)) {
        console.log(`Already verified ${entry.name}@${entry.version}`);
        continue;
      }
      allowLatest(entry, metadata);
      const archive = await verifiedArchive(directory, entry);
      try {
        run('npm', ['publish', archive, '--access=public', '--tag=latest', `--registry=${registry}`, '--provenance', '--ignore-scripts', '--fetch-retries=0']);
      } catch (error) {
        console.error(`npm returned an error for ${entry.name}@${entry.version}. Checking the registry before continuing.`, error.message);
      }
    }
    await waitForVersion(entry, request, sleep);
    console.log(`Verified registry integrity for ${entry.name}@${entry.version}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'Usage: node scripts/release/publish-batch.mjs <publish|verify> <artifact-dir>');
  await publishBatch(...process.argv.slice(2));
}
