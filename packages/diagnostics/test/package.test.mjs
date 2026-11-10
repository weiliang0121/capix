import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import { test } from 'node:test';

test('diagnostics has no dependency on live invocation, structure, resources or Runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@weiliang0121/capix-diagnostics');
  assert.deepEqual(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).sort(), ['@weiliang0121/capix-contracts', 'es-toolkit']);
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
});
