import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '../dist/server/observer/environment.js';
import { acceptExecutionInput } from '../dist/server/observer/accept.js';
import { observeExecution } from '../dist/server/observer/observe.js';
import { Transcript } from '../dist/server/transcript/transcript.js';

const settings = { model: 'one', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('one initialized world preserves messages and records while reusing its execution and operations', async () => {
  const requests = [];
  const provider = {
    async invoke(request, purpose, signal) {
      requests.push({ request, signal });
      const input = JSON.parse(request.messages[1].content);
      if (input.query === 'failure' && purpose === 'selection') throw new Error('expected failure');
      return raw(purpose === 'selection' ? { historyIndexes: input.history.map((message) => message.index) } : { kind: 'answer', content: `reply ${input.query}` });
    },
  };
  const transcript = new Transcript([{ role: 'user', content: 'initial' }]);
  const environment = initializeObserver(provider, transcript);
  assert.equal(environment.transcript, transcript);
  assert.equal([...environment.book.values()].length, 0);
  assert.equal(requests.length, 0);
  const operationIds = ['selection', 'assembly', 'generation'].map((name) => environment.execution[name].id);
  const snapshots = [],
    streamed = [];
  for (const [index, text] of ['first', 'failure', 'last'].entries()) {
    const input = acceptExecutionInput(transcript, { messages: [{ role: 'user', content: text }] });
    const published = [];
    snapshots.push(await observeExecution(environment.execution, environment.recorder, input, { settings: { ...settings, model: String(index) }, transcript }, (snapshot) => published.push(snapshot)));
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
    ['0', '0', '1', '2', '2'],
  );
  assert.deepEqual(
    JSON.parse(requests[3].request.messages[1].content).history.map((message) => message.content),
    ['initial', 'first', 'reply first', 'failure'],
  );
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
  assert.equal(new Set(records.map((record) => record.contextId)).size, records.length);
  for (const snapshot of snapshots) {
    assert.ok(environment.book.get(snapshot.execution.id));
    assert.equal(snapshot.events[0].sequence, 1);
    assert.equal(snapshot.events.at(-1).callId, snapshot.execution.id);
  }
  assert.equal(snapshots[0].execution.value.input.index, 1);
  assert.equal(snapshots[0].execution.value.input.read().content, 'first');
  assert.deepEqual(
    streamed.map((values) => new Set(values.map((snapshot) => snapshot.execution.id)).size),
    [1, 1, 1],
  );
  assert.deepEqual(
    streamed.map((values) => values.length),
    [26, 8, 26],
  );
});

test('invalid submissions cannot replace an initialized Transcript or partially append a batch', () => {
  const environment = initializeObserver(
    {
      invoke() {
        throw new Error('must not invoke');
      },
    },
    new Transcript([{ role: 'user', content: 'existing' }]),
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
      () => acceptExecutionInput(environment.transcript, { messages }),
      (error) => error.code === 'INVALID_INPUT',
    );
    assert.equal(environment.transcript.length, 1);
    assert.equal([...environment.book.values()].length, 0);
  }
});

test('a cancelled call does not leave its signal on the reusable model operation', async () => {
  const signals = [];
  const environment = initializeObserver({
    async invoke(request, purpose, signal) {
      signals.push(signal);
      signal.throwIfAborted();
      return raw(purpose === 'selection' ? { historyIndexes: [] } : { kind: 'answer', content: 'done' });
    },
  });
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancel first call'));
  for (const signal of [cancelled.signal, new AbortController().signal]) {
    const input = acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content: 'input' }] });
    const snapshot = await observeExecution(environment.execution, environment.recorder, input, { settings, signal });
    assert.equal(snapshot.execution.status, signal.aborted ? 'failed' : 'succeeded');
  }
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, false, false],
  );
});
