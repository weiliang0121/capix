import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const registry = 'https://registry.npmjs.org';
export const releaseDirectory = join(root, '.capix', 'release');
export const banner = '/*! MIT License | Copyright (c) 2026 wei.liang | See LICENSE */';

/** The same production-only allowlist applies to public and private tarballs. */
export function isDistributionFile(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  if (['package.json', 'LICENSE', 'README.md'].includes(path)) return true;
  if (!/^dist\/.+\.(?:js|d\.ts)$/.test(path)) return false;
  const parts = path.slice('dist/'.length).split('/');
  if (parts.some((part) => /^(?:__tests__|tests?|fixtures?|benchmarks?)(?:\.(?:js|d\.ts))?$/.test(part))) return false;
  return !/\.(?:test|spec)\.(?:js|d\.ts)$/.test(parts.at(-1));
}

export function command(file, args, options = {}) {
  return execFileSync(file, args, { cwd: root, stdio: 'inherit', ...options });
}

export async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function packages() {
  const directories = ['packages/contracts', 'packages/protocol', 'packages/changes', 'packages/checkpoint', 'packages/diagnostics', 'packages/interaction', 'packages/invocation', 'packages/measurement', 'packages/memory', 'packages/model-exchanges', 'packages/model-provider', 'packages/records', 'packages/resources', 'packages/runtime', 'packages/structure', 'packages/transcript', 'packages/view'];
  const result = await Promise.all(directories.map(async (directory) => ({ directory, path: join(root, directory), manifest: await json(join(root, directory, 'package.json')) })));
  const byName = new Map(result.map((entry) => [entry.manifest.name, entry]));
  assert.equal(byName.size, result.length, 'Duplicate release package names');
  const versions = new Set(result.map((entry) => entry.manifest.version));
  assert.equal(versions.size, 1, 'The fixed release group must have one version');
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  for (const { directory, path, manifest } of result) {
    assert.equal(manifest.name, `@weiliang0121/capix-${directory.split('/').at(-1)}`, `${directory}: unexpected release package name`);
    assert.equal(manifest.private, false, `${manifest.name}: release package is not public`);
    assert.equal(manifest.license, 'MIT');
    assert.equal(await readFile(join(path, 'LICENSE'), 'utf8'), license, `${manifest.name}: inconsistent license`);
    assert.equal(manifest.publishConfig?.registry, registry);
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.deepEqual(manifest.files, ['dist/**/*.js', 'dist/**/*.d.ts', 'LICENSE', 'README.md']);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (version.startsWith('workspace:')) assert.ok(byName.has(name), `${manifest.name}: unpublished dependency ${name}`);
        if (byName.has(name)) assert.equal(version, 'workspace:*', `${manifest.name}: internal dependencies must resolve to the released version`);
      }
    }
  }
  for (const parent of ['packages']) {
    for (const name of await readdir(join(root, parent))) {
      if (directories.includes(`${parent}/${name}`)) continue;
      let manifest;
      try {
        manifest = await json(join(root, parent, name, 'package.json'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      assert.equal(manifest.private, true, `${manifest.name}: outside the release scope`);
    }
  }
  assert.equal((await json(join(root, 'package.json'))).private, true, 'The workspace root must remain private');
  const config = await json(join(root, '.changeset/config.json'));
  assert.deepEqual(config.fixed, [[...byName.keys()].sort()], 'Changesets must match the exact release group');
  return result;
}

export async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink in release output: ${path}`);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
