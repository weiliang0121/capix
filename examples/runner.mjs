import assert from 'node:assert/strict';
import { createDictionaryRunner } from './dictionary.mjs';

// build 固定结构与资源接线；每次 run 才建立独立调用。
const runner = createDictionaryRunner();
const result = await runner.run('hello');
assert.equal(result, '你好');
assert.equal(await runner.run('unknown'), 'unknown');
assert.equal(runner.isRunning, false);
console.log(result); // 你好
