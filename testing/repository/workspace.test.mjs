import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packages = [
  { path: 'packages/contracts', allowed: [] },
  { path: 'packages/protocol', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'packages/model-provider', allowed: [] },
  { path: 'packages/model-exchanges', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-model-provider', '@weiliang0121/capix-resources', '@weiliang0121/capix-view'] },
  { path: 'packages/diagnostics', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'packages/interaction', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-changes', '@weiliang0121/capix-diagnostics'] },
  { path: 'packages/changes', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'packages/resources', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-changes'] },
  { path: 'packages/structure', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-resources'] },
  { path: 'packages/tool', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-structure', '@weiliang0121/capix-resources', '@weiliang0121/capix-interaction', '@weiliang0121/capix-model-provider', '@weiliang0121/capix-model-exchanges'] },
  { path: 'packages/transcript', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-view'] },
  { path: 'packages/memory', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-transcript', '@weiliang0121/capix-view'] },
  { path: 'packages/view', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-resources'] },
  { path: 'packages/measurement', allowed: ['@weiliang0121/capix-protocol', '@weiliang0121/capix-resources'] },
  { path: 'packages/records', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-changes', '@weiliang0121/capix-resources', '@weiliang0121/capix-transcript', '@weiliang0121/capix-memory'] },
  { path: 'packages/checkpoint', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'packages/invocation', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-changes', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-diagnostics'] },
  { path: 'packages/runtime', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-structure', '@weiliang0121/capix-changes', '@weiliang0121/capix-records', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-invocation', '@weiliang0121/capix-interaction', '@weiliang0121/capix-diagnostics'] },
];

test('the boundary inventory covers every workspace package', async () => {
  const discovered = [];
  for (const directory of ['packages']) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${directory}/${entry.name}`;
      try {
        const manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'));
        assert.equal(manifest.name, `@weiliang0121/capix-${entry.name}`);
        assert.equal(manifest.private, false);
        discovered.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  assert.deepEqual(discovered.sort(), packages.map((pkg) => pkg.path).sort());
});
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
      if (name.startsWith('@capix/') || name.startsWith('@weiliang0121/capix-')) assert.ok(pkg.allowed.includes(name), `${pkg.path} cannot depend on ${name}`);
    }
    for (const file of await sources(resolve(dir, 'src'))) {
      const content = await readFile(file, 'utf8');
      for (const match of content.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (specifier.startsWith('@capix/') || specifier.startsWith('@weiliang0121/capix-')) {
          const [scope, name, ...subpath] = specifier.split('/');
          const packageName = `${scope}/${name}`;
          assert.ok(pkg.allowed.includes(packageName), `${relative(root, file)} cannot depend on ${packageName}`);
          const entry = subpath.length ? `./${subpath.join('/')}` : '.';
          assert.ok(manifests.get(packageName)?.exports?.[entry], `${relative(root, file)} must use a public package export: ${specifier}`);
        }
        if (specifier.startsWith('.')) assert.ok(!relative(dir, resolve(dirname(file), specifier)).startsWith('..'), `${relative(root, file)} crosses a package boundary: ${specifier}`);
        if (pkg.path === 'packages/contracts' || pkg.path === 'packages/protocol') assert.ok(!specifier.startsWith('node:') && !['react', 'express', 'radix-ui'].includes(specifier), `${pkg.path} cannot depend on ${specifier}`);
      }
    }
  }
});
