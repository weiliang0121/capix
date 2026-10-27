import { Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';

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
const unsubscribe = runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') process.stdout.write(event.delta);
  },
});

await runner.run('第一轮输出\n');
await runner.run('第二轮仍使用同一个订阅\n');
unsubscribe();

// 停止消费不影响执行；最终结果仍从本次 Promise 取得。
console.log(await runner.run('解除订阅后的最终结果'));

// 宿主需要停止当前运行时调用 runner.cancel()；空闲时不会影响下一轮。
console.log('空闲取消：', runner.cancel());
