import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = [
  { path: 'contracts', allowed: [] },
  { path: 'protocol', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'server/model-provider', allowed: [] },
  { path: 'server/model-exchanges', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-model-provider', '@weiliang0121/capix-resources', '@weiliang0121/capix-view'] },
  { path: 'server/diagnostics', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'server/interaction', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-changes', '@weiliang0121/capix-diagnostics'] },
  { path: 'server/changes', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol'] },
  { path: 'server/resources', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol'] },
  { path: 'server/structure', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-resources'] },
  { path: 'server/transcript', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-view'] },
  { path: 'server/memory', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-changes', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-transcript', '@weiliang0121/capix-view'] },
  { path: 'server/view', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-resources'] },
  { path: 'server/measurement', allowed: ['@weiliang0121/capix-protocol', '@weiliang0121/capix-resources'] },
  { path: 'server/records', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-changes', '@weiliang0121/capix-resources'] },
  { path: 'server/checkpoint', allowed: ['@weiliang0121/capix-contracts'] },
  { path: 'server/invocation', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-changes', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-diagnostics'] },
  { path: 'server/runtime', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-structure', '@weiliang0121/capix-changes', '@weiliang0121/capix-records', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-invocation', '@weiliang0121/capix-interaction', '@weiliang0121/capix-diagnostics'] },
  { path: 'services/observer-content', allowed: ['@weiliang0121/capix-contracts', '@weiliang0121/capix-changes', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-transcript', '@weiliang0121/capix-memory', '@weiliang0121/capix-view'] },
  { path: 'services/conversation', allowed: ['@weiliang0121/capix-model-exchanges', '@weiliang0121/capix-model-provider', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-structure', '@weiliang0121/capix-transcript', '@weiliang0121/capix-memory', '@weiliang0121/capix-view', '@weiliang0121/capix-runtime', '@weiliang0121/capix-interaction', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-records', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-contracts', '@weiliang0121/capix-changes'] },
  { path: 'services/observer', allowed: ['@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', '@weiliang0121/capix-structure', '@weiliang0121/capix-runtime', '@weiliang0121/capix-contracts', '@weiliang0121/capix-changes', '@weiliang0121/capix-transcript', '@weiliang0121/capix-memory', '@weiliang0121/capix-view', '@weiliang0121/capix-measurement', '@weiliang0121/capix-records', '@capix/observer-content', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-invocation', '@weiliang0121/capix-interaction'] },
  { path: 'client/runtime', allowed: ['@weiliang0121/capix-protocol'] },
  { path: 'client/http', allowed: ['@weiliang0121/capix-protocol', '@capix/client-runtime'] },
  { path: 'apps/observer', allowed: ['@weiliang0121/capix-protocol', '@capix/client-runtime', '@capix/client-http'] },
];

test('the boundary inventory covers every workspace package', async () => {
  const discovered = ['contracts', 'protocol'];
  for (const directory of ['server', 'client', 'services', 'apps']) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${directory}/${entry.name}`;
      try {
        const manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'));
        if (directory === 'server') assert.equal(manifest.name, `@weiliang0121/capix-${entry.name}`);
        else {
          assert.equal(manifest.private, true, `${path} is outside the release scope`);
          assert.ok(manifest.name.startsWith('@capix/'), `${path} must have an explicit private package boundary`);
        }
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
        if (pkg.path === 'contracts' || pkg.path === 'protocol' || pkg.path.startsWith('client/')) assert.ok(!specifier.startsWith('node:') && !['react', 'express', 'radix-ui'].includes(specifier), `${pkg.path} cannot depend on ${specifier}`);
      }
    }
  }
});

test('shared protocol has no UI projection or server entity exports', async () => {
  const protocol = await import('@weiliang0121/capix-protocol');
  assert.equal(typeof protocol.readOutput, 'function');
  assert.equal(typeof protocol.validateExecutionRecordSnapshot, 'function');
  for (const name of ['Runtime', 'Transcript', 'Memory', 'projectExecution', 'createObserverServer']) assert.ok(!(name in protocol), `${name} does not belong to the wire contract`);
});
