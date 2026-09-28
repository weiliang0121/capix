import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptExecutionInput, observeExecution, inspectExecutions } from '@capix-observer/service';

import { Transcript } from '@capix-observer/runtime';

const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 512, timeoutMs: 10000 };

test('QA projection preserves missing answers and binds repeated answers to actual execution evidence', async () => {
  let failure = 'answer';
  const environment = initializeObserver(
    {
      async invoke(_request, purpose) {
        if (purpose === failure) throw new Error('expected failure');
        if (purpose === 'selection') return raw({ historyIndexes: [] });
        if (purpose === 'memory') return raw({ memories: [] });
        return raw({ kind: 'answer', content: '相同的回答' });
      },
    },
    new Transcript([
      { role: 'user', content: '导入原文' },
      { role: 'assistant', content: '相同的回答' },
    ]).snapshot(),
  );
  const run = async () => observeExecution(environment.execution, environment.recording, acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content: '相同的输入' }] }), { settings, transcript: environment.transcript });
  const failed = await run();
  failure = '';
  const completed = await run();
  failure = 'memory';
  const afterFailure = await run();
  const before = [...environment.book.values()];
  const observation = inspectExecutions(environment.book, environment.transcript);
  assert.equal(observation.executions.length, 3);
  assert.deepEqual(
    observation.executions.map((item) => item.inputIndex),
    [2, 3, 5],
  );
  assert.equal(observation.executions[0].id, failed.execution.id);
  assert.equal(observation.executions[0].response, undefined);
  assert.equal(observation.executions[1].id, completed.execution.id);
  assert.deepEqual(observation.executions[1].response, { content: '相同的回答', index: 4 });
  assert.equal(observation.executions[2].id, afterFailure.execution.id);
  assert.deepEqual(observation.executions[2].response, { content: '相同的回答', index: 6 });
  assert.equal(observation.executions[2].status, 'failed');
  assert.equal(observation.executions[2].memoryStatus, 'failed');
  assert.deepEqual([...environment.book.values()], before);
});
