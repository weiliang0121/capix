import { createDictionaryRunner } from './dictionary.mjs';

// build 固定结构与资源接线；每次 run 才建立独立调用。
const runner = createDictionaryRunner();
console.log(await runner.run('hello')); // 你好
