import { subscribeExecutions } from '@capix-observer/service';
import { ExecutionRecordHelper } from '@capix-observer/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Execution, Runtime, RuntimeRecorder, RecordBook } from '@capix-observer/runtime';
import { ObserverExecution } from '@capix-observer/service';

import { TestOperation } from './fixtures/operation.mjs';
import { createInput, transcriptFor } from './fixtures/observer.mjs';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };

test('one Execution and Operation can be called again after success and failure with fresh Contexts and records', async () => {
  const snapshots = [];
  const recorder = new RuntimeRecorder(new RecordBook(), undefined);
  const runtime = new Runtime({ recorder: recorder });
  subscribeExecutions(runtime.recording, (snapshot) => snapshots.push(snapshot));
  const failure = new Error('work failed');
  const contexts = [];
  const operation = new TestOperation(runtime, {
    load: (value) => value,
    transform: (value) => {
      if (value.fail) throw failure;
      return value;
    },
    accept: (value) => value,
  });
  class EchoExecution extends Execution {
    execute(context) {
      contexts.push(context);
      return operation.call(context, context.input);
    }
  }
  const execution = new EchoExecution(runtime.executionInvocations);
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
  const records = contexts.map((context) => ExecutionRecordHelper.observe(runtime.recording, context));
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
      return { id: 'test', model: request.model, content: JSON.stringify(purpose === 'memory' ? { memories: [] } : purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' }), finishReason: 'stop', usage: null };
    },
  };
  const runtime = new Runtime();
  const execution = new ObserverExecution(runtime, provider);
  for (const model of ['one', 'two']) {
    runtime.transcript.append({ role: 'user', content: model });
    const message = runtime.transcript.current('user');
    const answer = await execution.call(message, { settings: { ...settings, model }, transcript: runtime.transcript });
    assert.deepEqual(answer, { kind: 'answer', content: 'done' });
    assert.equal(runtime.transcript.current('assistant').content, 'done');
  }
  assert.deepEqual(
    requests.map((request) => request.model),
    ['one', 'one', 'one', 'two', 'two', 'two'],
  );
});
