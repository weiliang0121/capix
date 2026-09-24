import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { observeExecution } from '../../dist/server/observer/observe.js';

const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 256, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

for (const fails of [false, true]) {
  test(`selection is recorded without appending messages when generation ${fails ? 'fails' : 'succeeds'}`, async () => {
    const requests = [];
    const environment = initializeObserver({
      async invoke(request, purpose) {
        requests.push(request);
        if (purpose === 'memory') return raw({ memories: [] });
        assert.deepEqual(environment.transcript.snapshot(), messagesBefore);
        if (purpose === 'selection') return raw({ historyIndexes: [1, 0] });
        assert.deepEqual(
          JSON.parse(request.messages[1].content).history.map(({ index }) => index),
          [0, 1],
        );
        if (fails) throw new Error('generation failed');
        return raw({ kind: 'answer', content: '在南楼201。' });
      },
    });
    const input = acceptExecutionInput(environment.transcript, {
      messages: [
        { role: 'user', content: '春芽活动在南楼201。' },
        { role: 'assistant', content: '已了解活动地点。' },
        { role: 'user', content: '活动在哪里？' },
      ],
    });
    const messagesBefore = environment.transcript.snapshot();
    const facts = await observeExecution(environment.execution, environment.recorder, input, { settings, transcript: environment.transcript });
    const selection = facts.operations.find((operation) => operation.operation === 'selection');
    assert.equal(selection.status, 'succeeded');
    assert.deepEqual(selection.value.output, { historyIndexes: [1, 0] });
    assert.equal(requests.length, fails ? 2 : 3);
    assert.equal(facts.execution.status, fails ? 'failed' : 'succeeded');
    assert.equal(facts.execution.value.transcriptRange.end, 3);
    assert.deepEqual(environment.transcript.snapshot(), fails ? messagesBefore : [...messagesBefore, { role: 'assistant', content: '在南楼201。' }]);
    for (let index = 0; index < messagesBefore.length; index++) assert.equal(environment.transcript.get(index), messagesBefore[index]);
  });
}

test('message counts accumulate independently and never enter model requests', async () => {
  const { ObserverExecution } = await import('../../dist/server/observer/execution.js');
  const { Runtime } = await import('../../dist/server/runtime/runtime.js');
  const { Transcript } = await import('../../dist/server/transcript/transcript.js');
  const transcript = new Transcript([{ role: 'user', content: '我在北京' }]);
  const original = transcript.get(0);
  const requests = [];
  let indexes = [0];
  let fails = false;
  const execution = new ObserverExecution(new Runtime(), {
    async invoke(request, purpose) {
      const loaded = JSON.parse(request.messages[1].content);
      assert.doesNotMatch(JSON.stringify(request), /selectionCount/);
      if (purpose === 'memory') return raw({ memories: [] });
      assert.deepEqual(Object.keys(loaded.message).sort(), ['content', 'role']);
      assert.ok(loaded.history.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['content', 'index', 'role'])));
      if (purpose === 'selection') {
        requests.push(loaded);
        return raw({ historyIndexes: indexes });
      }
      assert.ok(loaded.history.every((item) => !('selectionCount' in item)));
      if (fails) throw new Error('generation failed');
      return raw({ kind: 'answer', content: '测试回复' });
    },
  });
  const run = async () => {
    transcript.append({ role: 'user', content: '继续' });
    return execution.call(transcript.current('user'), { settings, transcript });
  };
  await run();
  assert.equal(requests.length, 1);
  assert.equal(execution.selection.usage.get(original), 1);
  fails = true;
  await assert.rejects(run(), /generation failed/);
  assert.equal(requests.length, 2);
  assert.equal(execution.selection.usage.get(original), 2);
  fails = false;
  indexes = [0, 0];
  await assert.rejects(run());
  assert.equal(execution.selection.usage.get(original), 2);
  indexes = [];
  await run();
  assert.equal(requests.length, 4);
  assert.equal(execution.selection.usage.get(original), 2);
  assert.deepEqual(original, { role: 'user', content: '我在北京' });
  assert.equal(transcript.get(0), original);
  assert.equal(execution.selection.usage.get(Object.freeze({ ...original })), 0);
});
