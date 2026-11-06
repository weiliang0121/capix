import assert from 'node:assert/strict';
import { createComparisonExample } from './assembly.mjs';

if (process.argv.length > 2) throw new Error('Usage: node examples/parallel-analysis/run.mjs (offline only)');

// Gates prove overlap and reversed completion without relying on model speed or
// timers. The provider still returns complete ModelReply values through resources.
const branches = new Map();
const bothStarted = Promise.withResolvers();
const completed = [];
const previews = [];
let merged;
const model = {
  async complete(request, controls) {
    const input = JSON.parse(request.messages[1].content);
    if (input.stage === 'analysis') {
      const gate = Promise.withResolvers();
      branches.set(input.material.index, gate);
      controls.emit(`内部分析 ${input.material.index}`);
      if (branches.size === 2) bothStarted.resolve();
      const analysis = await gate.promise;
      completed.push(input.material.index);
      return { id: `analysis-${input.material.index}`, model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: analysis }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
    }
    merged = input;
    controls.emit('两个方案的主要区别：');
    controls.emit('发布时间与测试余量。');
    return { id: 'merged', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: '两个方案的主要区别：发布时间与测试余量。' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
  },
};

const { runner, content, recording } = createComparisonExample({ model, recording: true });
runner.output.subscribe({
  receive: (event) => {
    if (event.kind === 'delta') previews.push(event.delta);
  },
});
const pending = runner.run('比较两个发布方案的风险。');
await bothStarted.promise;
branches.get(2).resolve('B 留足测试时间，但依赖跨团队联调。');
// Await the provider's B return, not an arbitrary sleep. A is still gated.
await branches.get(2).promise;
branches.get(0).resolve('A 发布更早，但测试时间紧张。');
const result = await pending;
recording.stop();
assert.deepEqual(completed, [2, 0]);
assert.equal(merged.primary.material.index, 0);
assert.equal(merged.secondary.material.index, 2);
assert.equal(content.transcript.length, 5);
assert.equal(content.transcript.snapshot().at(-1).content, result);
assert.equal(previews.join(''), result, 'internal branch previews must not leak');
const capture = recording.inspect(content).recording;
const detail = recording.call(capture.calls[0].id);
assert.equal(detail.integrity, 'intact');
console.log('离线并行组合验证通过（不评价模型分析质量）：');
console.log(JSON.stringify({ overlappingBranches: branches.size, completionOrder: completed, acceptedSources: [merged.primary.material.index, merged.secondary.material.index], output: result, preview: previews, messages: content.transcript.length, calls: detail.calls.length, recording: capture.status }, null, 2));
