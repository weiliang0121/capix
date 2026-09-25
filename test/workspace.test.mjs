import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = [
  { path: 'protocol', allowed: [] },
  { path: 'server/runtime', allowed: ['@capix-observer/protocol'] },
  { path: 'services/observer', allowed: ['@capix-observer/protocol', '@capix-observer/runtime'] },
  { path: 'client/runtime', allowed: ['@capix-observer/protocol'] },
  { path: 'client/http', allowed: ['@capix-observer/protocol', '@capix-observer/client-runtime'] },
  { path: 'apps/observer', allowed: ['@capix-observer/protocol', '@capix-observer/client-runtime', '@capix-observer/client-http'] },
];
async function sources(directory) {
  const files = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      files.map(async (entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? sources(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
      }),
    )
  ).flat();
}

test('workspace production imports follow one-way public package boundaries', async () => {
  for (const pkg of packages) {
    const dir = resolve(root, pkg.path);
    const manifest = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@capix-observer/')) assert.ok(pkg.allowed.includes(name), `${pkg.path} cannot depend on ${name}`);
    }
    for (const file of await sources(resolve(dir, 'src'))) {
      const content = await readFile(file, 'utf8');
      for (const match of content.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (specifier.startsWith('@capix-observer/')) assert.ok(pkg.allowed.includes(specifier), `${relative(root, file)} must use an allowed public package export: ${specifier}`);
        if (specifier.startsWith('.')) assert.ok(!relative(dir, resolve(dirname(file), specifier)).startsWith('..'), `${relative(root, file)} crosses a package boundary: ${specifier}`);
        if (pkg.path === 'protocol' || pkg.path.startsWith('client/')) assert.ok(!specifier.startsWith('node:') && !['react', 'express', 'radix-ui'].includes(specifier), `${pkg.path} cannot depend on ${specifier}`);
      }
    }
  }
});

test('shared protocol has no UI projection or server entity exports', async () => {
  const protocol = await import('@capix-observer/protocol');
  assert.equal(typeof protocol.readOutput, 'function');
  assert.equal(typeof protocol.validateSnapshot, 'function');
  for (const name of ['Runtime', 'Transcript', 'Memory', 'projectExecution', 'createObserverServer']) assert.ok(!(name in protocol), `${name} does not belong to the wire contract`);
});
