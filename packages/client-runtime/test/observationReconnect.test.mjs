import test from 'node:test';

import assert from 'node:assert/strict';

import { ObservationConnectionError } from '@capix/client-runtime';

import { baseline, client, conversationDescriptor, deferred, entriesOf, snapshot, transport, transcriptSnapshot } from './fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

const untilAbort = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

test('manual reconnection preserves accepted data and touches neither messages nor submissions', async (t) => {
  const failure = deferred();
  const connections = [];
  const io = transport();
  let posts = 0;
  let messageConnections = 0;
  const watchMessages = io.observeTranscript;
  io.observeTranscript = (...args) => {
    messageConnections++;
    return watchMessages(...args);
  };
  io.submit = async () => {
    posts++;
  };
  const runtime = client({
    conversation: io,
    observation: {
      observe: async (_conversationId, receive, signal) => {
        connections.push({ receive, signal });
        if (connections.length === 1) {
          receive(baseline({ entries: entriesOf(snapshot()) }));
          await failure.promise;
        } else await untilAbort(signal);
      },
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  t.after(() => {
    stop();
    runtime.stopTranscript();
  });
  await settle();
  const accepted = runtime.getSnapshot().observation;
  failure.reject(new ObservationConnectionError('offline'));
  await settle();
  assert.equal(runtime.getSnapshot().observation.reconnectable, true);
  assert.equal(runtime.getSnapshot().observation.records, accepted.records);
  assert.equal(connections.length, 1, 'network failures await an explicit retry');
  await runtime.refreshObservation();
  assert.equal(connections.length, 2);
  assert.equal(runtime.getSnapshot().observation.loading, true);
  assert.equal(runtime.getSnapshot().observation.records, accepted.records);
  connections[1].receive(baseline({ scopeId: 'new-scope', entries: entriesOf(snapshot()) }));
  await settle();
  assert.equal(runtime.getSnapshot().observation.reconnectable, false);
  assert.equal(runtime.getSnapshot().observation.error, undefined);
  assert.equal(runtime.getSnapshot().observation.cursor.scopeId, 'new-scope');
  assert.equal(messageConnections, 1);
  assert.equal(posts, 0);
});

for (const kind of ['incomplete', 'identity', 'scope', 'consumer']) {
  test(`${kind} failure cannot be bypassed by manual refresh or replacing observation owners`, async (t) => {
    let connections = 0;
    const runtime = client({
      conversation: transport(),
      observation: {
        observe: async (_conversationId, receive) => {
          connections++;
          if (kind === 'incomplete') throw Object.assign(new Error('source incomplete'), { code: 'SOURCE_INCOMPLETE' });
          if (kind === 'consumer') throw new TypeError('consumer failed');
          if (kind === 'identity') receive(baseline({ transcript: { id: 'foreign', revision: 0, starts: [0] } }));
          else {
            receive(baseline());
            receive({ type: 'delta', scopeId: 'foreign', sequence: 1, changes: [] });
          }
        },
      },
    });
    await runtime.initialize();
    const stop = runtime.startObservation();
    t.after(() => runtime.stopTranscript());
    await settle();
    assert.equal(connections, 1);
    const error = runtime.getSnapshot().observation.error;
    assert.ok(error);
    assert.equal(runtime.getSnapshot().observation.reconnectable, false);
    await runtime.refreshObservation();
    stop();
    const replacement = runtime.startObservation();
    t.after(replacement);
    await settle();
    assert.equal(connections, 1);
    assert.equal(runtime.getSnapshot().observation.error, error);
  });
}

test('a failed observation scope does not prevent opening and observing another conversation', async (t) => {
  const next = conversationDescriptor('next', 'next-transcript');
  const io = transport({ conversation: async () => next, activeSubmission: async (id) => ({ conversationId: id, transcriptId: id === next.id ? next.transcriptId : 'fixture-transcript' }) });
  io.observeTranscript = async (id, receive, signal) => {
    receive({ type: 'baseline', snapshot: transcriptSnapshot([], id) });
    await untilAbort(signal);
  };
  const observed = [];
  const runtime = client({
    conversation: io,
    observation: {
      observe: async (id, receive, signal) => {
        observed.push(id);
        if (id !== next.id) throw Object.assign(new Error('source incomplete'), { code: 'SOURCE_INCOMPLETE' });
        receive(baseline({ transcript: { id: next.transcriptId, revision: 0, starts: [0] }, overview: { transcriptId: next.transcriptId, executions: [], messages: [] } }));
        await untilAbort(signal);
      },
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  t.after(() => {
    stop();
    runtime.stopTranscript();
  });
  await settle();
  await runtime.openConversation(next.id);
  await settle();
  assert.deepEqual(observed, ['fixture-conversation', next.id]);
  assert.equal(runtime.getSnapshot().observation.error, undefined);
  assert.equal(runtime.getSnapshot().conversation.id, next.id);
});

test('an unexpectedly fulfilled observation stream is an explicit reconnectable interruption', async (t) => {
  const runtime = client({ conversation: transport(), observation: { observe: async (_id, receive) => receive(baseline()) } });
  await runtime.initialize();
  const stop = runtime.startObservation();
  t.after(() => {
    stop();
    runtime.stopTranscript();
  });
  await settle();
  assert.equal(runtime.getSnapshot().observation.reconnectable, true);
  assert.equal(runtime.getSnapshot().observation.loading, false);
  assert.ok(runtime.getSnapshot().observation.error instanceof ObservationConnectionError);
});
