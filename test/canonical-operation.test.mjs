import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDictionaryRunner } from '../examples/dictionary.mjs';

test('the public dictionary example composes resources and named child operations across runs', async () => {
  const runner = createDictionaryRunner();
  assert.equal(await runner.run('hello'), '你好');
  assert.equal(await runner.run('unknown'), 'unknown');
  assert.equal(runner.isRunning, false);
  const independent = createDictionaryRunner(new Map([['hello', '您好']]));
  assert.equal(await independent.run('hello'), '您好');
  assert.equal(await runner.run('hello'), '你好');
});
