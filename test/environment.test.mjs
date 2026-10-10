import { resourceFact } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptConversationInput, observeExecution } from '@capix/observer-service';

import { Transcript } from '@capix/server-runtime';

const settings = { model: 'one', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('one initialized world preserves messages and records while reusing its execution and operations', async () => {
  const requests = [];
  const provider = {
    async invoke(request, purpose, signal) {
      requests.push({ request, signal });
      if (purpose === 'memory') return raw({ memories: [] });
      const input = JSON.parse(request.messages[1].content);
      if (input.message.content === 'failure' && purpose === 'selection') throw new Error('expected failure');
      return raw(purpose === 'memory' ? { memories: [] } : purpose === 'selection' ? { historyIndexes: input.history.map((message) => message.index) } : { kind: 'answer', content: `reply ${input.message.content}` });
    },
  };
  const environment = initializeObserver(provider, [{ role: 'user', content: 'initial' }]);
  const transcript = environment.transcript;
  assert.equal(environment.transcript, transcript);
  assert.equal([...environment.book.values()].length, 2); // Initial transcript + Runtime scope.
  assert.equal(requests.length, 0);
  assert.equal(Object.hasOwn(environment.runtime, 'context'), false);
  const snapshots = [];
  const streamed = [];
  for (const [index, text] of ['first', 'failure', 'last'].entries()) {
    const input = { messages: [{ role: 'user', content: text }] };
    const published = [];
    snapshots.push(await observeExecution(environment.runtime, environment.recording, input, { settings: { ...settings, model: String(index) }, transcript }, (snapshot) => published.push(snapshot)));
    streamed.push(published);
  }
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.execution.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.deepEqual(
    transcript.snapshot().map((message) => message.content),
    ['initial', 'first', 'reply first', 'failure', 'last', 'reply last'],
  );
  assert.deepEqual(
    requests.map(({ request }) => request.model),
    ['0', '0', '0', '1', '2', '2', '2'],
  );
  assert.deepEqual(
    JSON.parse(requests[4].request.messages[1].content).history.map((message) => message.content),
    ['initial', 'first', 'reply first', 'failure'],
  );
  const operationIds = snapshots[0].operations.map((record) => record.operationInstanceId);
  assert.deepEqual(
    snapshots[0].operations.map((record) => record.operationInstanceId),
    operationIds,
  );
  assert.deepEqual(
    snapshots[2].operations.map((record) => record.operationInstanceId),
    operationIds,
  );
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.execution.id)).size, 3);
  const records = [...environment.book.values()];
  assert.equal(new Set(records.filter((record) => 'status' in record && 'contextId' in record).map((record) => record.contextId)).size, records.filter((record) => 'status' in record && 'contextId' in record).length);
  for (const snapshot of snapshots) {
    assert.ok(environment.book.get(snapshot.execution.id));
    assert.equal(snapshot.events[0].sequence, 1);
    assert.equal(snapshot.events.at(-1).callId, snapshot.execution.id);
  }
  assert.equal(resourceFact(snapshots[0], 'transcript.fixedRange').end, 2);
  assert.equal(snapshots[0].execution.value.input.content, 'first');
  assert.deepEqual(
    streamed.map((values) => new Set(values.map((snapshot) => snapshot.execution.id)).size),
    [1, 1, 1],
  );
  assert.deepEqual(
    streamed.map((values) => values.length),
    snapshots.map((snapshot) => snapshot.events.length + [snapshot.execution, ...snapshot.operations, ...snapshot.attempts].reduce((count, record) => count + record.value.processes.length + record.value.relationChanges.length, 0)),
  );
});

test('invalid submissions cannot replace an initialized Transcript or partially append a batch', () => {
  const environment = initializeObserver(
    {
      invoke() {
        throw new Error('must not invoke');
      },
    },
    new Transcript([{ role: 'user', content: 'existing' }]).snapshot(),
  );
  for (const messages of [
    [],
    [{ role: 'assistant', content: 'last' }],
    [
      { role: 'user', content: 'valid' },
      { role: 'user', content: ' ' },
    ],
    [
      { role: 'system', content: 'invalid' },
      { role: 'user', content: 'last' },
    ],
  ]) {
    assert.throws(
      () => acceptConversationInput(environment.transcript, { messages }),
      (error) => error.code === 'INVALID_INPUT',
    );
    assert.equal(environment.transcript.length, 1);
    assert.equal([...environment.book.values()].length, 2); // Initial transcript + Runtime scope.
  }
});

test('a cancelled call does not leave its signal on the reusable model operation', async () => {
  const signals = [];
  const environment = initializeObserver({
    async invoke(request, purpose, signal) {
      signals.push(signal);
      signal.throwIfAborted();
      return raw(purpose === 'memory' ? { memories: [] } : purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' });
    },
  });
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancel first call'));
  for (const signal of [cancelled.signal, new AbortController().signal]) {
    const input = { messages: [{ role: 'user', content: 'input' }] };
    const completion = observeExecution(environment.runtime, environment.recording, input, { settings, signal, transcript: environment.transcript });
    if (signal.aborted) {
      await assert.rejects(completion, { code: 'INVOCATION_CANCELLED' });
      assert.equal(environment.transcript.length, 0);
    } else assert.equal((await completion).execution.status, 'succeeded');
  }
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [false, false, false],
  );
});

test('configuration updates and Transcript appends take effect only in the next execution', async () => {
  const configuration = { ...settings, model: 'A' };
  const requests = [];
  let environment;
  environment = initializeObserver({
    async invoke(request, purpose) {
      requests.push(request);
      if (requests.length === 1) {
        configuration.model = 'B';
        environment.transcript.append({ role: 'user', content: 'arrived during first call' });
      }
      return raw(purpose === 'memory' ? { memories: [] } : purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' });
    },
  });
  const snapshots = [];
  for (const content of ['first', 'next']) {
    const input = { messages: [{ role: 'user', content }] };
    assert.equal(Object.hasOwn(input, 'transcript'), false);
    snapshots.push(await observeExecution(environment.runtime, environment.recording, input, { settings: configuration, transcript: environment.transcript }));
  }
  assert.deepEqual(
    requests.map((request) => request.model),
    ['A', 'A', 'A', 'B', 'B', 'B'],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => resourceFact(snapshot, 'model-settings.snapshot').model),
    ['A', 'B'],
  );
  assert.deepEqual(
    snapshots.map((snapshot) => resourceFact(snapshot, 'transcript.fixedRange').end),
    [1, 4],
  );
  assert.equal(JSON.parse(requests[0].messages[1].content).history.length, 0);
  assert.equal(JSON.parse(requests[3].messages[1].content).history.length, 3);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.operations.every((record) => record.executionId === snapshot.execution.id));
    assert.ok([...snapshot.operations, ...snapshot.attempts].every((record) => !Object.hasOwn(record.value, 'settings') && !Object.hasOwn(record.value, 'transcriptRange')));
  }
});
