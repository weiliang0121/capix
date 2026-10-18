import { ModelInteractions, ModelSource } from '@capix/observer-service';
import { createEnvironment } from './fixtures/environment.mjs';
import { ExecutionFixture } from './fixtures/behavior.mjs';
import { callFor, rememberCall } from './fixtures/lifecycle.mjs';
import { subscribeExecutions } from '@capix/observer-service';
import { ExecutionRecordHelper } from '@capix/server-runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder, RecordBook } from '@capix/server-runtime';
import { createBoundRuntime, observeCall } from './fixtures/runtime.mjs';
import { bindConversation, ConversationRuntimeDefinition } from '@capix/observer-service';

import { TestOperation } from './fixtures/operation.mjs';
import { createInput, transcriptFor } from './fixtures/observer.mjs';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };

test('one Execution and Operation can be called again after success and failure with fresh Contexts and records', async () => {
  const snapshots = [];
  const recorder = new Recorder(new RecordBook(), { clock: undefined });
  const runtime = createBoundRuntime({ recorder });
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
  class EchoExecution extends ExecutionFixture {
    execute(context, invocation) {
      rememberCall(invocation);
      contexts.push(context);
      return operation.call(invocation, context.input);
    }
  }
  const execution = new EchoExecution(runtime.executionInvocationBuilder);
  const first = { value: 'first' };
  const last = { value: 'last' };
  assert.equal(snapshots.length, 0);
  assert.equal(await execution.call(first, { settings }), first);
  await assert.rejects(execution.call({ fail: true }, { settings }), (error) => error === failure);
  assert.equal(await execution.call(last, { settings }), last);
  assert.equal(new Set(contexts.map((context) => context.id)).size, 3);
  assert.deepEqual(
    contexts.map((context) => context.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  const records = contexts.map((context) => observeCall(runtime.recording, callFor(context)));
  assert.equal(new Set(records.map((snapshot) => snapshot.execution.id)).size, 3);
  assert.equal(new Set(records.map((snapshot) => snapshot.operations[0].id)).size, 3);
  assert.ok(records.every((snapshot) => snapshot.operations[0].operationInstanceId === operation.id));
  assert.deepEqual(
    records.map((snapshot) => snapshot.attempts.length),
    [3, 2, 3],
  );
});

test('bindConversation, ConversationRuntimeDefinition returns answers without a recorder and uses the configuration of each call', async () => {
  const requests = [];
  const provider = {
    async invoke(request, purpose) {
      requests.push(request);
      return { id: 'test', model: request.model, content: JSON.stringify(purpose === 'memory' ? { memories: [] } : purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' }), finishReason: 'stop', usage: null };
    },
  };
  const entities = createEnvironment();
  const runtime = bindConversation(new ConversationRuntimeDefinition(), entities, new ModelInteractions(new ModelSource(provider)));
  for (const model of ['one', 'two']) {
    const answer = await runtime.run({ messages: [{ role: 'user', content: model }] }, { settings: { ...settings, model } });
    assert.deepEqual(answer, { kind: 'answer', content: 'done' });
    assert.equal(entities.transcript.current('assistant').content, 'done');
  }
  assert.deepEqual(
    requests.map((request) => request.model),
    ['one', 'one', 'two', 'two'],
  );
});
