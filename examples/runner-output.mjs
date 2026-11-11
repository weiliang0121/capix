import assert from 'node:assert/strict';
import { Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';

function text(value) {
  if (typeof value !== 'string') throw new TypeError('Expected text');
  return value;
}

const scene = new Scene({
  output: { result: text, delta: text },
  run(work) {
    for (const character of work.input) work.output.emit(character);
    return work.input;
  },
});
const runner = new Runner(scene, new Resources()).build();

// 订阅属于 Runner，每条事件保留本次根调用的 contextId。
const events = [];
const unsubscribe = runner.output.subscribe({
  receive(event) {
    events.push(event);
    if (event.kind === 'delta') process.stdout.write(event.delta);
  },
});

assert.equal(await runner.run('第一轮输出\n'), '第一轮输出\n');
assert.equal(await runner.run('第二轮仍使用同一个订阅\n'), '第二轮仍使用同一个订阅\n');
unsubscribe();

// 停止消费不影响执行；最终结果仍从本次 Promise 取得。
const eventCount = events.length;
const final = await runner.run('解除订阅后的最终结果');
assert.equal(final, '解除订阅后的最终结果');
assert.equal(events.length, eventCount);
assert.equal(
  events
    .filter((event) => event.kind === 'delta')
    .map((event) => event.delta)
    .join(''),
  '第一轮输出\n第二轮仍使用同一个订阅\n',
);
assert.deepEqual(
  events.filter((event) => event.kind === 'completed').map((event) => event.result),
  ['第一轮输出\n', '第二轮仍使用同一个订阅\n'],
);
assert.equal(new Set(events.map((event) => event.entryId)).size, 2);
assert.equal(new Set(events.map((event) => event.contextId)).size, 2);
assert.equal(runner.isRunning, false);
console.log(final);

// 宿主需要停止当前运行时调用 runner.cancel()；空闲时不会影响下一轮。
const cancelled = runner.cancel();
assert.equal(cancelled, false);
console.log('空闲取消：', cancelled);
