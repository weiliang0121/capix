import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationSequenceError } from '@capix/client-runtime';
import { baseline, client, deferred, entriesOf, snapshot, transport } from './fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const untilAbort = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

const runtimeWith = (observation) => client({ conversation: transport(), observation });

test('replacement observation owner isolates old delivery and old stop handles', async () => {
  const connections = [];
  const runtime = runtimeWith({
    observe: async (_conversationId, receive, signal) => {
      connections.push({ receive, signal });
      receive(baseline({ scopeId: `scope-${connections.length}` }));
      await untilAbort(signal);
    },
  });
  await runtime.initialize();
  const stopFirst = runtime.startObservation();
  await settle();
  const previous = runtime.getSnapshot().observation;
  const stopSecond = runtime.startObservation();
  assert.equal(connections[0].signal.aborted, true);
  stopFirst();
  connections[0].receive(baseline({ scopeId: 'stale' }));
  await settle();
  assert.equal(connections[1].signal.aborted, false);
  assert.equal(runtime.getSnapshot().observation.cursor.scopeId, 'scope-2');
  assert.equal(previous.cursor.scopeId, 'scope-1');
  stopSecond();
  await settle();
  assert.equal(runtime.getSnapshot().observation.enabled, false);
  assert.equal(connections[1].signal.aborted, true);
  await settle();
});

test('observation delivery sequence failures receive at most one baseline retry', async () => {
  let connections = 0;
  const runtime = runtimeWith({
    observe: async (_conversationId, receive) => {
      connections++;
      receive({ type: 'delta', scopeId: 'missing', sequence: 1, changes: [] });
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  await settle();
  assert.equal(connections, 2);
  assert.equal(runtime.getSnapshot().observation.loading, false);
  assert.ok(runtime.getSnapshot().observation.error instanceof ObservationSequenceError);
  stop();
});

test('source incompleteness never triggers automatic baseline reconstruction', async () => {
  let connections = 0;
  const failure = Object.assign(new Error('source is incomplete', { cause: new ObservationSequenceError('missing fact') }), { code: 'SOURCE_INCOMPLETE' });
  const runtime = runtimeWith({
    observe: async () => {
      connections++;
      throw failure;
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  await settle();
  assert.equal(connections, 1);
  assert.equal(runtime.getSnapshot().observation.error, failure);
  stop();
});

test('synchronously thrown transport errors remain inside the observation state', async () => {
  const failure = new Error('transport rejected before returning its promise');
  const runtime = runtimeWith({
    observe: () => {
      throw failure;
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  await settle();
  assert.equal(runtime.getSnapshot().observation.error, failure);
  assert.equal(runtime.getSnapshot().observation.loading, false);
  stop();
  await settle();
});

test('an unconnected detail request cannot survive an intervening start and stop', async () => {
  const response = deferred();
  const runtime = runtimeWith({
    execution: () => response.promise,
    observe: async (_conversationId, receive, signal) => {
      receive(baseline());
      await untilAbort(signal);
    },
  });
  await runtime.initialize();
  const pending = runtime.loadExecution('execution-1');
  runtime.startObservation()();
  response.resolve(snapshot());
  await assert.rejects(pending, /忽略旧详情响应/);
  assert.equal(runtime.getExecution('execution-1'), undefined);
});

test('live detail updates take precedence over an older pending detail response', async () => {
  const response = deferred();
  let receive;
  let reads = 0;
  const running = snapshot('running');
  const terminal = snapshot();
  const runtime = runtimeWith({
    execution: () => {
      reads++;
      return response.promise;
    },
    observe: async (_conversationId, accept, signal) => {
      receive = accept;
      accept(baseline({ entries: entriesOf(running) }));
      await untilAbort(signal);
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  const pending = runtime.loadExecution('execution-1');
  receive({ type: 'delta', scopeId: 'fixture-scope', sequence: 1, changes: entriesOf(terminal).map((entry, index) => ({ type: 'record', recorderId: 'fixture-recorder', revision: index + 1, occurredAt: '2026-10-11T00:00:00Z', change: { kind: 'replaced', entry } })) });
  response.resolve(running);
  assert.deepEqual(await pending, terminal);
  assert.deepEqual(await runtime.loadExecution('execution-1'), terminal);
  assert.equal(reads, 1);
  stop();
});

test('a previous connection rejection cannot clear or fail a refreshed observation', async () => {
  const old = deferred();
  let connections = 0;
  const runtime = runtimeWith({
    observe: async (_conversationId, receive, signal) => {
      connections++;
      receive(baseline({ scopeId: `scope-${connections}` }));
      if (connections === 1) await old.promise;
      else await untilAbort(signal);
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  await runtime.refreshObservation();
  old.reject(new Error('stale failure'));
  await settle();
  assert.equal(runtime.getSnapshot().observation.cursor.scopeId, 'scope-2');
  assert.equal(runtime.getSnapshot().observation.error, undefined);
  assert.equal(runtime.getSnapshot().observation.enabled, true);
  stop();
});

for (const command of ['stop', 'replace', 'failure']) {
  test(`an observation started by an abort listener survives the previous owner's ${command}`, async () => {
    const connections = [];
    const failure = deferred();
    let stopReplacement;
    const runtime = runtimeWith({
      observe: async (_conversationId, receive, signal) => {
        const first = connections.length === 0;
        connections.push({ receive, signal });
        receive(baseline({ scopeId: `scope-${connections.length}` }));
        if (first) {
          signal.addEventListener('abort', () => (stopReplacement = runtime.startObservation()), { once: true });
          if (command === 'failure') await failure.promise;
          else await untilAbort(signal);
        } else await untilAbort(signal);
      },
    });
    await runtime.initialize();
    const stop = runtime.startObservation();
    if (command === 'stop') stop();
    else if (command === 'replace') runtime.startObservation()();
    else failure.reject(new Error('old connection failed'));
    await settle();
    assert.equal(connections.length, 2);
    connections[1].receive({ type: 'delta', scopeId: 'scope-2', sequence: 1, changes: [] });
    await settle();
    assert.equal(runtime.getSnapshot().observation.enabled, true);
    assert.equal(runtime.getSnapshot().observation.error, undefined);
    assert.equal(runtime.getSnapshot().observation.cursor.scopeId, 'scope-2');
    assert.equal(runtime.getSnapshot().observation.cursor.sequence, 1);
    assert.equal(connections[1].signal.aborted, false);
    stopReplacement();
  });
}
