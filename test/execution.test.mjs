import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Execution } from '../dist/server/execution/execution.js';
import { ObserverExecution } from '../dist/server/observer/execution.js';
import { Runtime } from '../dist/server/runtime/runtime.js';
import { RuntimeRecorder } from '../dist/server/records/recorder.js';
import { RecordBook, RecordIndex } from '../dist/server/records/index.js';
import { TestOperation } from './fixtures/operation.mjs';
import { createInput, transcriptFor } from './fixtures/observer.mjs';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const definition = { name: 'echo', label: 'echo', source: 'test', phaseSource: 'test' };

test('one Execution and Operation can be called again after success and failure with fresh Contexts and records', async () => {
  const snapshots = [];
  const recorder = new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), new RecordIndex((record) => record.executionId), undefined, (snapshot) => snapshots.push(snapshot));
  const runtime = new Runtime(recorder);
  const failure = new Error('work failed');
  const contexts = [];
  const operation = new TestOperation(runtime, definition, {
    before: (value) => value,
    commit: (value) => {
      if (value.fail) throw failure;
      return value;
    },
    after: (value) => value,
  });
  class EchoExecution extends Execution {
    execute(context) {
      contexts.push(context);
      return operation.call(context, context.input);
    }
  }
  const execution = new EchoExecution(runtime);
  const first = { value: 'first' },
    last = { value: 'last' };
  assert.equal(snapshots.length, 0);
  assert.equal(await execution.call(first, { settings }), first);
  await assert.rejects(execution.call({ fail: true }, { settings }), (error) => error === failure);
  assert.equal(await execution.call(last, { settings }), last);
  assert.equal(new Set(contexts.map((context) => context.id)).size, 3);
  assert.deepEqual(
    contexts.map((context) => context.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  const records = contexts.map((context) => recorder.snapshot(context));
  assert.equal(new Set(records.map((snapshot) => snapshot.execution.id)).size, 3);
  assert.equal(new Set(records.map((snapshot) => snapshot.operations[0].id)).size, 3);
  assert.ok(records.every((snapshot) => snapshot.operations[0].operationInstanceId === operation.id));
  assert.deepEqual(
    records.map((snapshot) => snapshot.attempts.length),
    [3, 2, 3],
  );
});

test('ObserverExecution returns answers without a recorder and uses the configuration of each call', async () => {
  const requests = [];
  const provider = {
    async invoke(request, purpose) {
      requests.push(request);
      return { id: 'test', model: request.model, content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' }), finishReason: 'stop', usage: null };
    },
  };
  const execution = new ObserverExecution(new Runtime(), provider);
  for (const model of ['one', 'two']) {
    const query = createInput({ query: model, history: [] });
    const answer = await execution.call(query, { settings: { ...settings, model }, transcript: transcriptFor(query) });
    assert.deepEqual(answer, { kind: 'answer', content: 'done' });
    assert.equal(transcriptFor(query).current('assistant').content, 'done');
  }
  assert.deepEqual(
    requests.map((request) => request.model),
    ['one', 'one', 'two', 'two'],
  );
});
