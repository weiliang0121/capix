import assert from 'node:assert/strict';
import { createDictionaryRunner } from '../../examples/dictionary.mjs';
import { createSequenceRunner, createDynamicRunner } from '../../examples/presets.mjs';

const name = process.argv[2];
if (name === 'dictionary') {
  const runner = createDictionaryRunner(new Map([['hello', '你好']]));
  assert.equal(await runner.run('hello'), '你好');
  assert.equal(await runner.run('missing'), 'missing');
  assert.equal(runner.isRunning, false);
} else if (name === 'presets') {
  const documents = new Map([['input.txt', 'hello']]);
  const sequence = createSequenceRunner(documents);
  assert.deepEqual(await sequence.run({ source: 'input.txt', destination: 'output.txt' }), { path: 'output.txt', text: 'HELLO' });
  assert.equal(documents.get('output.txt'), 'HELLO');
  assert.equal(documents.get('input.txt'), 'hello');
  assert.equal(sequence.isRunning, false);
  const dynamic = createDynamicRunner();
  assert.equal(await dynamic.run('hello'), 'HELLO');
  assert.equal(await dynamic.run('world'), 'WORLD');
  assert.equal(dynamic.isRunning, false);
} else {
  throw new Error(`Unknown factory example: ${name}`);
}
console.log(`${name}: result and state assertions passed`);
