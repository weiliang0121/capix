import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, json, packages, root } from './packages.mjs';

function stableVersion(version) {
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, `Expected a stable package version, received ${version}`);
  return version.split('.').map(BigInt);
}

function releaseSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const headings = [];
  let fence;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else if (/^##\s+/.test(line)) {
      headings.push({ title: line.slice(2).trim(), index });
    }
  }
  assert.equal(headings[0]?.title, version, `Expected latest CHANGELOG section for ${version}`);
  assert.equal(headings.filter(({ title }) => title === version).length, 1, `Duplicate CHANGELOG section for ${version}`);
  const section = lines
    .slice(headings[0].index + 1, headings[1]?.index ?? lines.length)
    .join('\n')
    .trim();
  assert.ok(section, `Empty CHANGELOG section for ${version}`);
  return section;
}

function dependencyOrder(selected) {
  const ordered = new Map();
  const visiting = new Set();
  function visit(entry) {
    const { name, dependencies, peerDependencies, optionalDependencies } = entry.manifest;
    if (ordered.has(name)) return;
    assert.ok(!visiting.has(name), `Cyclic release dependency at ${name}`);
    visiting.add(name);
    for (const dependency of Object.keys({ ...dependencies, ...peerDependencies, ...optionalDependencies }).sort()) {
      if (selected.has(dependency)) visit(selected.get(dependency));
    }
    visiting.delete(name);
    ordered.set(name, entry);
  }
  for (const entry of selected.values()) visit(entry);
  return [...ordered.values()];
}

export async function prepareBatch(base, source, prNumber, directory, workspace = root) {
  assert.match(base, /^[a-f0-9]{40}$/, 'Expected full version PR base SHA');
  assert.match(source, /^[a-f0-9]{40}$/, 'Expected full version PR merge SHA');
  assert.match(String(prNumber), /^[1-9]\d*$/, 'Expected version PR number');
  const pullRequest = Number(prNumber);
  assert.ok(Number.isSafeInteger(pullRequest), 'Invalid version PR number');
  const git = (...args) => command('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(git('rev-parse', 'HEAD').trim(), source, 'Check out the exact version PR merge commit');
  assert.equal(git('show', '-s', '--format=%P', source).trim(), base, 'Expected a squash merge onto the version PR base');

  const entries = await packages(workspace);
  const verified = await json(join(directory, 'verified.json'));
  const archives = new Map(verified.packages.map((archive) => [archive.name, archive]));
  assert.equal(archives.size, verified.packages.length, 'Duplicate verified package');
  assert.equal(archives.size, entries.length, 'Incomplete verified package inventory');
  const selected = new Map();
  for (const entry of entries) {
    const path = `${entry.directory}/package.json`;
    const previous = JSON.parse(git('show', `${base}:${path}`));
    const manifest = JSON.parse(git('show', `${source}:${path}`));
    const { name, version } = manifest;
    assert.equal(name, previous.name, `Package renamed at ${path}`);
    assert.deepEqual(manifest, entry.manifest, `Checkout differs from release source at ${path}`);
    const archive = archives.get(name);
    assert.equal(archive?.version, version, `Missing verified artifact for ${name}@${version}`);
    if (previous.version === version) continue;
    const before = stableVersion(previous.version);
    const after = stableVersion(version);
    const changed = after.findIndex((part, index) => part !== before[index]);
    assert.ok(after[changed] > before[changed], `Version must increase for ${name}`);
    assert.equal(archive.file, `${name.slice(1).replace('/', '-')}-${version}.tgz`, `Unexpected tarball filename for ${name}`);
    const bytes = await readFile(join(directory, archive.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), archive.sha256, `Artifact changed after verification: ${name}`);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const notes = releaseSection(git('show', `${source}:${entry.directory}/CHANGELOG.md`), version);
    selected.set(name, { manifest, artifact: { name, version, file: archive.file, integrity }, notes });
  }
  assert.ok(selected.size, 'No package versions changed in this PR');
  const ordered = dependencyOrder(selected);
  const manifest = { schemaVersion: 1, source, pullRequest, packages: ordered.map(({ artifact }) => artifact) };
  const notes = [`Version PR #${pullRequest} · Source \`${source}\``, ...ordered.map(({ artifact, notes }) => `## ${artifact.name}@${artifact.version}\n\n${notes}\n\n[npm package](https://www.npmjs.com/package/${artifact.name}/v/${artifact.version})`)];
  await writeFile(join(directory, 'release-notes.md'), notes.join('\n\n') + '\n');
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 6, 'Usage: node scripts/release/batch.mjs <base-sha> <merge-sha> <pr-number> <artifact-dir>');
  await prepareBatch(...process.argv.slice(2));
}
