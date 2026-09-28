import { readOutput } from '@capix-observer/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptExecutionInput, observeExecution } from '@capix-observer/service';

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
    const facts = await observeExecution(environment.execution, environment.recording, input, { settings, transcript: environment.transcript });
    const selection = facts.operations.find((operation) => operation.operation === 'selection');
    assert.equal(selection.status, 'succeeded');
    assert.deepEqual(readOutput(selection.value), { historyIndexes: [1, 0] });
    assert.equal(requests.length, fails ? 2 : 3);
    assert.equal(facts.execution.status, fails ? 'failed' : 'succeeded');
    assert.equal(facts.execution.value.transcriptRange.end, 3);
    assert.deepEqual(environment.transcript.snapshot(), fails ? messagesBefore : [...messagesBefore, { role: 'assistant', content: '在南楼201。' }]);
    for (let index = 0; index < messagesBefore.length; index++) assert.equal(environment.transcript.get(index), messagesBefore[index]);
  });
}

test('message counts accumulate independently and never enter model requests', async () => {
  const { ObserverExecution } = await import('@capix-observer/service');
  const { Runtime } = await import('@capix-observer/runtime');
  const { Transcript } = await import('@capix-observer/runtime');
  const runtime = new Runtime({ messages: [{ role: 'user', content: '我在北京' }] });
  const transcript = runtime.transcript;
  const original = transcript.get(0);
  const requests = [];
  let indexes = [0];
  let fails = false;
  const execution = new ObserverExecution(runtime, {
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
  assert.equal(runtime.selectionUsage.get(original), 1);
  fails = true;
  await assert.rejects(run(), /generation failed/);
  assert.equal(requests.length, 2);
  assert.equal(runtime.selectionUsage.get(original), 2);
  fails = false;
  indexes = [0, 0];
  await assert.rejects(run());
  assert.equal(runtime.selectionUsage.get(original), 2);
  indexes = [];
  await run();
  assert.equal(requests.length, 4);
  assert.equal(runtime.selectionUsage.get(original), 2);
  assert.deepEqual(original, { role: 'user', content: '我在北京' });
  assert.equal(transcript.get(0), original);
  assert.equal(runtime.selectionUsage.get(Object.freeze({ ...original })), 0);
});
