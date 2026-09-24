import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { observeExecution } from '../../dist/server/observer/observe.js';
import { observeSelection } from '../../dist/server/observer/selection.js';
import { Transcript } from '../../dist/server/transcript/transcript.js';

const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 256, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('heat counts accepted selection calls, not attempts, execution success or observation reads', async () => {
  let indexes = [1, 0];
  let failGeneration = false;
  let inspectDuringGeneration = () => {};
  const environment = initializeObserver(
    {
      async invoke(_request, purpose) {
        if (purpose === 'memory') return raw({ memories: [] });
        if (purpose === 'selection') return raw({ historyIndexes: indexes });
        inspectDuringGeneration();
        if (failGeneration) throw new Error('generation failed');
        return raw({ kind: 'answer', content: '回复' });
      },
    },
    new Transcript([
      { role: 'user', content: '春芽在南楼。' },
      { role: 'assistant', content: '已了解。' },
    ]),
  );
  const project = () => observeSelection(environment.book, environment.transcript, environment.execution.selection.id);
  const run = async (content) => {
    const input = acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content }] });
    return observeExecution(environment.execution, environment.recorder, input, { settings, transcript: environment.transcript });
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
  indexes = [0];
  failGeneration = true;
  const second = await run('再确认一下。');
  assert.equal(second.execution.status, 'failed');
  assert.deepEqual(
    project().messages.map((item) => item.count),
    [2, 1, 0, 0, 0],
  );
  indexes = [];
  failGeneration = false;
  await run('换一个话题。');
  indexes = [0, 0];
  const invalid = await run('无效重复索引');
  assert.equal(invalid.execution.status, 'failed');
  const view = project();
  assert.deepEqual(view, project());
  assert.equal(view.executions.length, 4);
  assert.deepEqual(view.executions[0].selections[0].indexes, [1, 0]);
  assert.equal(view.executions[0].id, first.execution.id);
  assert.equal(view.executions[0].selections[0].operationId, first.operations.find((item) => item.operation === 'selection').id);
  assert.deepEqual(view.executions[2].selections[0].indexes, []);
  assert.equal(view.executions[3].selections[0].status, 'failed');
  assert.equal(view.executions[3].selections[0].indexes, undefined);
  assert.deepEqual(
    view.messages.map((item) => item.count),
    [2, 1, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(view.messages[0].message, environment.transcript.get(0));
  view.executions[0].selections[0].indexes.push(99);
  view.messages[0].count = 500;
  assert.deepEqual(project().executions[0].selections[0].indexes, [1, 0]);
  assert.equal(project().messages[0].count, 2);
});

test('heat isolates Transcript identity and the concrete selection operation instance', async () => {
  const environment = initializeObserver({
    async invoke(_request, purpose) {
      if (purpose === 'memory') return raw({ memories: [] });
      return raw(purpose === 'selection' ? { historyIndexes: [0] } : { kind: 'answer', content: '回复' });
    },
  });
  const other = new Transcript([
    { role: 'user', content: '另一份消息' },
    { role: 'user', content: '继续' },
  ]);
  await observeExecution(environment.execution, environment.recorder, other.current('user'), { settings, transcript: other });
  assert.deepEqual(observeSelection(environment.book, environment.transcript, environment.execution.selection.id), { messages: [], executions: [] });
  assert.deepEqual(
    observeSelection(environment.book, other, 'another-operation').messages.map((item) => item.count),
    [0, 0, 0],
  );
  assert.deepEqual(
    observeSelection(environment.book, other, environment.execution.selection.id).messages.map((item) => item.count),
    [1, 0, 0],
  );
});
