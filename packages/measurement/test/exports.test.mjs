import assert from 'node:assert/strict';

import { test } from 'node:test';

import { readFile, readdir } from 'node:fs/promises';

import { fileURLToPath } from 'node:url';

const packages = [{ name: '@weiliang0121/capix-measurement', exports: ['MessageUsage', 'MessageUsageResource'] }];

test('content packages load through public roots without importing callable structures or runtime', async () => {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.ts')) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, /@weiliang0121\/capix-(?:structure|runtime|protocol)|@capix\/observer-service|(?:\.\.\/)+(?:structure|runtime|protocol)\//, fileURLToPath(path));
      }
    }
  }
  for (const pkg of packages) {
    const directory = new URL('../', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    assert.equal(manifest.name, pkg.name);
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) assert.ok(!['@weiliang0121/capix-structure', '@weiliang0121/capix-runtime', '@weiliang0121/capix-protocol', '@capix/observer-service'].includes(dependency), `${pkg.name} cannot depend on ${dependency}`);
    await inspect(new URL('src/', directory));
    await inspect(new URL('dist/', directory));
    const exported = await import(pkg.name);
    for (const name of pkg.exports) assert.ok(name in exported, `${pkg.name} must export ${name}`);
    for (const name of ['Runner', 'Invocation', 'Scene', 'Group', 'Node', 'Recorder', 'updateMemory', 'restoreMemory']) assert.equal(name in exported, false, `${pkg.name} must not expose ${name}`);
  }
});
