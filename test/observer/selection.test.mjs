import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptConversationInput, observeExecution, observeSelection } from '@capix/observer-service';

import { Transcript } from '@weiliang0121/capix-transcript';

const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 256, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('reference counts follow accepted active material, independently of generation success and observation reads', async () => {
  let failGeneration = false;
  let inspectDuringGeneration = () => {};
  const environment = initializeObserver(
    {
      async invoke(_request, purpose) {
        if (purpose === 'memory') return raw({ memories: [] });
        assert.notEqual(purpose, 'selection');
        inspectDuringGeneration();
        if (failGeneration) throw new Error('generation failed');
        return raw({ kind: 'answer', content: '回复' });
      },
    },
    new Transcript([
      { role: 'user', content: '春芽在南楼。' },
      { role: 'assistant', content: '已了解。' },
    ]).snapshot(),
  );
  const project = () => observeSelection(environment.records.book, environment.transcript);
  const run = async (content) => {
    const input = { messages: [{ role: 'user', content }] };
    return observeExecution(environment.runner, environment.records.installation, input, { settings, transcript: environment.transcript });
  };
  assert.deepEqual(
    project().messages.map((item) => item.count),
    [0, 0],
  );
  inspectDuringGeneration = () => {
    const view = project();
    assert.deepEqual(
      view.messages.map((item) => item.count),
      [1, 1, 0],
    );
    assert.equal(view.executions[0].status, 'running');
    assert.equal(view.executions[0].selections[0].status, 'succeeded');
  };
  const first = await run('在哪里？');
  inspectDuringGeneration = () => {};
  const active = environment.content.active;
  active.apply({ basis: active.capture().basis, messageIndexes: [0], memoryIds: [] });
  failGeneration = true;
  const second = await run('再确认一下。');
  assert.equal(second.execution.status, 'failed');
  assert.deepEqual(
    project().messages.map((item) => item.count),
    [2, 1, 0, 0, 0],
  );
  active.apply({ basis: active.capture().basis, messageIndexes: [], memoryIds: [] });
  failGeneration = false;
  await run('换一个话题。');
  assert.throws(() => active.apply({ basis: active.capture().basis, messageIndexes: [0, 0], memoryIds: [] }), /unique/);
  const view = project();
  assert.deepEqual(view, project());
  assert.equal(view.executions.length, 3);
  assert.deepEqual(view.executions[0].selections[0].indexes, [0, 1]);
  assert.equal(view.executions[0].id, first.execution.id);
  assert.equal(view.executions[0].selections[0].operationId, first.calls.find((item) => item.name === 'prepareContext').id);
  assert.deepEqual(view.executions[2].selections[0].indexes, []);
  assert.deepEqual(
    view.messages.map((item) => item.count),
    [2, 1, 0, 0, 0, 0, 0],
  );
  assert.equal(view.messages[0].message, undefined);
  assert.equal(view.transcriptId, environment.transcript.id);
  view.executions[0].selections[0].indexes.push(99);
  view.messages[0].count = 500;
  assert.deepEqual(project().executions[0].selections[0].indexes, [0, 1]);
  assert.equal(project().messages[0].count, 2);
});

test('execution rejects a foreign Transcript and does not mutate either running scope', async () => {
  const environment = initializeObserver({
    invoke() {
      assert.fail('must not invoke');
    },
  });
  const other = new Transcript([
    { role: 'user', content: '另一份消息' },
    { role: 'user', content: '继续' },
  ]);
  await assert.rejects(observeExecution(environment.runner, environment.records.installation, other.current('user'), { settings, transcript: other }), { code: 'INVALID_INPUT' });
  assert.deepEqual(observeSelection(environment.records.book, environment.transcript), { transcriptId: environment.transcript.id, messages: [], executions: [] });
  assert.equal(other.length, 2);
  assert.equal(environment.runner.isRunning, false);
});
