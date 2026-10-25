import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = [
  { path: 'contracts', allowed: [] },
  { path: 'protocol', allowed: ['@capix/contracts'] },
  { path: 'server/resources', allowed: ['@capix/contracts', '@capix/protocol'] },
  { path: 'server/structure', allowed: ['@capix/contracts', '@capix/resources'] },
  { path: 'server/runtime', allowed: ['@capix/contracts', '@capix/protocol', '@capix/resources', '@capix/structure'] },
  { path: 'services/observer', allowed: ['@capix/protocol', '@capix/resources', '@capix/structure', '@capix/server-runtime'] },
  { path: 'client/runtime', allowed: ['@capix/protocol'] },
  { path: 'client/http', allowed: ['@capix/protocol', '@capix/client-runtime'] },
  { path: 'apps/observer', allowed: ['@capix/protocol', '@capix/client-runtime', '@capix/client-http'] },
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
  const manifests = new Map(
    await Promise.all(
      packages.map(async (pkg) => {
        const manifest = JSON.parse(await readFile(resolve(root, pkg.path, 'package.json'), 'utf8'));
        return [manifest.name, manifest];
      }),
    ),
  );
  for (const pkg of packages) {
    const dir = resolve(root, pkg.path);
    const manifest = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@capix')) assert.ok(pkg.allowed.includes(name), `${pkg.path} cannot depend on ${name}`);
    }
    for (const file of await sources(resolve(dir, 'src'))) {
      const content = await readFile(file, 'utf8');
      for (const match of content.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (specifier.startsWith('@capix')) {
          const [scope, name, ...subpath] = specifier.split('/');
          const packageName = `${scope}/${name}`;
          assert.ok(pkg.allowed.includes(packageName), `${relative(root, file)} cannot depend on ${packageName}`);
          const entry = subpath.length ? `./${subpath.join('/')}` : '.';
          assert.ok(manifests.get(packageName)?.exports?.[entry], `${relative(root, file)} must use a public package export: ${specifier}`);
        }
        if (specifier.startsWith('.')) assert.ok(!relative(dir, resolve(dirname(file), specifier)).startsWith('..'), `${relative(root, file)} crosses a package boundary: ${specifier}`);
        if (pkg.path === 'contracts' || pkg.path === 'protocol' || pkg.path.startsWith('client/')) assert.ok(!specifier.startsWith('node:') && !['react', 'express', 'radix-ui'].includes(specifier), `${pkg.path} cannot depend on ${specifier}`);
      }
    }
  }
});

test('shared protocol has no UI projection or server entity exports', async () => {
  const protocol = await import('@capix/protocol');
  assert.equal(typeof protocol.readOutput, 'function');
  assert.equal(typeof protocol.validateExecutionRecordSnapshot, 'function');
  for (const name of ['Runtime', 'Transcript', 'Memory', 'projectExecution', 'createObserverServer']) assert.ok(!(name in protocol), `${name} does not belong to the wire contract`);
});
