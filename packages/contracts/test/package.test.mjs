import assert from 'node:assert/strict';

import { test } from 'node:test';

import { readFile, readdir } from 'node:fs/promises';

import { fileURLToPath } from 'node:url';

import * as contracts from '@weiliang0121/capix-contracts';

test('contracts own shared vocabulary without a reverse implementation or wire dependency', async () => {
  assert.deepEqual(Object.keys(contracts).sort(), ['RuntimeError', 'StableValueError', 'callableKinds', 'stableValue', 'stableValueLimits']);
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        const content = await readFile(child, 'utf8');
        assert.doesNotMatch(content, /(?:from|import)\s*[(]?\s*['"](?:@capix\/|@weiliang0121\/capix-|node:|(?:\.\.\/)+(?:server|protocol)\/)/, fileURLToPath(child));
      }
    }
  }
  await inspect(new URL('src/', root));
  await inspect(new URL('dist/', root));
});
