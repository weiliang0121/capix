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
    assert.equal(requests.length, 2);
    assert.equal(facts.execution.status, fails ? 'failed' : 'succeeded');
    assert.equal(facts.execution.value.transcriptRange.end, 3);
    assert.deepEqual(environment.transcript.snapshot(), fails ? messagesBefore : [...messagesBefore, { role: 'assistant', content: '在南楼201。' }]);
    for (let index = 0; index < messagesBefore.length; index++) assert.equal(environment.transcript.get(index), messagesBefore[index]);
  });
}
