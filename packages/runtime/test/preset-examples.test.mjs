import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSequenceRunner } from '../../../examples/presets.mjs';
import { createDynamicRunner } from '../../../examples/presets.mjs';

test('Sequence example reads, transforms and saves through the public package APIs', async () => {
  const documents = new Map([['notes.md', 'hello']]);
  const runner = createSequenceRunner(documents);
  assert.deepEqual(await runner.run({ source: 'notes.md', destination: 'summary.md' }), { path: 'summary.md', text: 'HELLO' });
  assert.equal(documents.get('summary.md'), 'HELLO');
});

test('Dynamic example decides with a node and gives each run a fresh ordinary flow resource', async () => {
  const runner = createDynamicRunner();
  assert.equal(await runner.run('hello'), 'HELLO');
  assert.equal(await runner.run('again'), 'AGAIN');
});
