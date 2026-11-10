import test from 'node:test';

import assert from 'node:assert/strict';

import { ClientRuntime, TranscriptConnectionError, TranscriptSequenceError, TranscriptReplica } from '@capix/client-runtime';

import { conversationDescriptor, deferred, transcriptSnapshot, transport } from './fixtures.mjs';

const message = (content, role = 'user') => ({ role, content });

const baseline = (messages = [message('retained')], id = 'current', revision = messages.length) => ({ type: 'baseline', snapshot: transcriptSnapshot(messages, id, revision) });

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function tick(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

function fixture(t, options = {}) {
  const streams = [];
  let posts = 0;
  const conversation = transport({
    conversations: async () => ({ conversations: [conversationDescriptor('fixture-conversation', 'current')], defaultConversationId: 'fixture-conversation' }),
    activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 'current' }),
    submit: async (request, receive) => {
      posts++;
      const delivery = conversation.delivery(request, receive);
      delivery.input({ transcriptId: 'current', start: 0, end: 1 });
      delivery.answer();
      delivery.complete();
    },
  });
  const runtime = new ClientRuntime({
    conversation,
    transcripts: {
      transcript: async () => assert.fail('recovery uses an atomic stream baseline'),
      observeTranscript: async (id, accept, signal) => {
        const end = deferred();
        const stream = {
          id,
          signal,
          accept,
          fail: end.reject,
          finish: end.resolve,
          send(frame) {
            try {
              accept(frame);
            } catch (error) {
              end.reject(error);
            }
          },
        };
        streams.push(stream);
        signal.addEventListener('abort', () => end.resolve(), { once: true });
        if (options.autoBaseline !== false) stream.send(baseline(undefined, id));
        await end.promise;
      },
    },
  });
  t.after(() => {
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
  });
  return {
    runtime,
    streams,
    sync: (id = 'current') => runtime.getSnapshot().transcripts.get(id)?.sync,
    get posts() {
      return posts;
    },
  };
}

test('reconnection preserves formal content and waits for a new baseline without resubmitting business', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture(t, { autoBaseline: false });
  const init = f.runtime.initialize();
  await settle();
  f.streams[0].send(baseline());
  await init;
  await f.runtime.submit({ messages: [message('question')] });
  const confirmed = f.runtime.getSnapshot().submission.remote;
  const content = f.runtime.getSnapshot().messages;
  f.streams[0].fail(new TranscriptConnectionError('connection closed'));
  await settle();
  assert.equal(f.sync().status, 'retrying');
  assert.equal(f.sync().attempt, 1);
  assert.equal(f.sync().retryAt, 1500);
  assert.equal(f.runtime.getSnapshot().messages, content);
  assert.equal(f.runtime.getSnapshot().initialization.status, 'succeeded');
  let ready = false;
  const reconnected = f.runtime.initialize().then(() => {
    ready = true;
  });
  const loaded = f.runtime.loadTranscript('current');
  await settle();
  assert.equal(ready, false, 'initial readiness cannot substitute for recovery readiness');
  await tick(t, 499);
  assert.equal(f.streams.length, 1);
  await tick(t, 1);
  assert.equal(f.streams.length, 2);
  assert.equal(f.streams[1].id, 'current', 'reconnect is pinned to the original entity identity');
  assert.equal(f.sync().status, 'connecting');
  assert.equal(ready, false);
  f.streams[0].accept(baseline([message('stale callback')], 'current', 10));
  assert.equal(f.runtime.getSnapshot().messages, content);
  f.streams[1].send(baseline([message('retained'), message('answer', 'assistant')], 'current', 2));
  await reconnected;
  assert.equal((await loaded).end, 2);
  assert.equal(f.sync().status, 'live');
  assert.equal(f.runtime.getSnapshot().answerAvailability, 'available');
  assert.equal(f.runtime.getSnapshot().submission.remote, confirmed);
  assert.equal(f.posts, 1);
});

test('one current baseline produces one retained message copy and an unchanged reconnect reuses it', async (t) => {
  const f = fixture(t, { autoBaseline: false });
  const frame = baseline([message('first'), message('second', 'assistant')]);
  const map = frame.snapshot.messages.map.bind(frame.snapshot.messages);
  let copies = 0;
  Object.defineProperty(frame.snapshot.messages, 'map', {
    value: (project) => {
      copies++;
      return map(project);
    },
  });
  const initialized = f.runtime.initialize();
  await settle();
  f.streams[0].send(frame);
  await initialized;
  assert.equal(copies, 1);
  const retained = f.runtime.getSnapshot().messages;
  f.runtime.stopTranscript('current');
  const loaded = f.runtime.loadTranscript('current');
  f.streams[1].send(frame);
  await loaded;
  assert.equal(copies, 1);
  assert.equal(f.runtime.getSnapshot().messages, retained);
});

test('an older reconnect baseline retains a separate connection position until its deltas catch up', async (t) => {
  const f = fixture(t, { autoBaseline: false });
  const initialized = f.runtime.initialize();
  await settle();
  f.streams[0].send(baseline([message('first'), message('second', 'assistant')]));
  await initialized;
  const retained = f.runtime.getSnapshot().messages;
  f.runtime.stopTranscript('current');
  const loaded = f.runtime.loadTranscript('current');
  f.streams[1].send(baseline([message('first')]));
  await loaded;
  assert.equal(f.runtime.getSnapshot().messages, retained);
  for (const [revision, content, role] of [
    [2, 'second', 'assistant'],
    [3, 'third', 'user'],
  ]) {
    f.streams[1].send({ type: 'delta', event: { type: 'transcript', transcriptId: 'current', revision, occurredAt: '2026-10-13T00:00:00Z', change: { kind: 'messages-appended', start: revision - 1, messages: [message(content, role)] } } });
  }
  await settle();
  assert.deepEqual(
    f.runtime.getSnapshot().messages.map((entry) => entry.content),
    ['first', 'second', 'third'],
  );
  assert.equal(f.sync().status, 'live');
});

test('initial transient failures have a finite budget, reject readiness, and permit an explicit fresh attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { autoBaseline: false });
  const init = f.runtime.initialize();
  await settle();
  const failed = assert.rejects(init, TranscriptConnectionError);
  f.streams[0].fail(new TranscriptConnectionError('offline'));
  await settle();
  for (const delay of [500, 1500, 4000]) {
    await tick(t, delay);
    f.streams.at(-1).fail(new TranscriptConnectionError('still offline'));
    await settle();
  }
  await failed;
  assert.equal(f.streams.length, 4);
  assert.equal(f.runtime.getSnapshot().initialization.status, 'failed');
  await tick(t, 60000);
  assert.equal(f.streams.length, 4);
  const next = f.runtime.initialize();
  await settle();
  f.streams.at(-1).send(baseline());
  await next;
  assert.equal(f.sync().status, 'live');
  assert.equal(f.posts, 0);
});

test('baseline followed by EOF cannot reset the retry budget indefinitely', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.runtime.initialize();
  f.streams[0].finish();
  await settle();
  for (const delay of [500, 1500, 4000]) {
    await tick(t, delay);
    assert.equal(f.sync().status, 'live');
    f.streams.at(-1).finish();
    await settle();
  }
  assert.equal(f.streams.length, 4);
  assert.equal(f.sync().status, 'failed');
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'retained');
  await tick(t, 60000);
  assert.equal(f.streams.length, 4);
  await f.runtime.initialize();
  assert.equal(f.streams.length, 5);
  assert.equal(f.sync().status, 'live');
});

test('stopping a retry cancels its timer and waiting readiness; explicit restart ignores obsolete callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.runtime.initialize();
  f.streams[0].fail(new TranscriptConnectionError('offline'));
  await settle();
  const pending = f.runtime.loadTranscript('current');
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  f.runtime.stopTranscript('current');
  await stopped;
  assert.equal(f.sync().status, 'stopped');
  assert.equal(f.runtime.getSnapshot().messages.length, 1);
  await tick(t, 60000);
  assert.equal(f.streams.length, 1);
  await f.runtime.initialize();
  f.streams[0].accept(baseline([message('obsolete')], 'current', 99));
  await settle();
  assert.equal(f.sync().status, 'live');
  assert.equal(f.streams.length, 2);
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'retained');
});

test('identity and immutable prefix conflicts stop recovery and preserve the prior replica', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const frame of [baseline([message('retained')], 'another'), baseline([message('changed')], 'current', 1), baseline([message('changed')], 'current', 2)]) {
    const f = fixture(t, { autoBaseline: false });
    const init = f.runtime.initialize();
    await settle();
    f.streams[0].send(baseline());
    await init;
    const before = f.runtime.getSnapshot().messages;
    f.streams[0].finish();
    await settle();
    await tick(t, 500);
    const failure = assert.rejects(f.runtime.loadTranscript('current'), TranscriptSequenceError);
    f.streams[1].send(frame);
    await failure;
    assert.equal(f.sync().status, 'failed');
    assert.equal(f.runtime.getSnapshot().messages, before);
    await tick(t, 60000);
    assert.equal(f.streams.length, 2);
  }
});

test('a stable connection earns a fresh retry budget instead of inheriting an old outage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t);
  await f.runtime.initialize();
  f.streams[0].finish();
  await settle();
  await tick(t, 500);
  f.streams[1].finish();
  await settle();
  assert.equal(f.sync().attempt, 2);
  await tick(t, 1500);
  await tick(t, 30000);
  f.streams[2].finish();
  await settle();
  assert.equal(f.sync().attempt, 1);
  await tick(t, 500);
  assert.equal(f.streams.length, 4);
  assert.equal(f.sync().status, 'live');
});

test('connection abort listeners see recovery ownership and cannot receive stale readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { autoBaseline: false });
  const init = f.runtime.initialize();
  await settle();
  f.streams[0].send(baseline());
  await init;
  let ready = false;
  let waiting;
  f.streams[0].signal.addEventListener('abort', () => {
    waiting = f.runtime.loadTranscript('current').then(() => {
      ready = true;
    });
  });
  f.streams[0].finish();
  await settle();
  assert.equal(ready, false);
  await tick(t, 500);
  f.streams[1].send(baseline());
  await waiting;
  assert.equal(ready, true);
});

test('initialization shares a retrying explicit UID subscription without resetting its retry budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { autoBaseline: false });
  const named = f.runtime.loadTranscript('current');
  f.streams[0].send(baseline());
  await named;
  f.streams[0].finish();
  await settle();
  const recovered = f.runtime.loadTranscript('current');
  const initialized = f.runtime.initialize();
  await settle();
  assert.equal(f.streams.length, 1);
  await tick(t, 500);
  assert.equal(f.streams.length, 2);
  f.streams[1].send(baseline());
  await initialized;
  await recovered;
  await tick(t, 60000);
  assert.equal(f.streams.length, 2);
  assert.equal(f.streams[1].signal.aborted, false);
  assert.equal(f.sync().status, 'live');
});

test('a reconnecting entity does not stop another entity subscription or an already initialized command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.runtime.initialize();
  await f.runtime.loadTranscript('archive');
  f.streams[0].finish();
  await settle();
  const recovery = f.runtime.initialize();
  assert.equal(f.sync('archive').status, 'live');
  await f.runtime.submit({ messages: [message('a new command')] });
  assert.equal(f.posts, 1);
  await tick(t, 500);
  await recovery;
  assert.equal(f.sync().status, 'live');
  assert.equal(f.sync('archive').status, 'live');
});

test('recovery baselines preserve append-only messages and segment boundaries at every revision', () => {
  const old = TranscriptReplica.receive(undefined, { ...baseline([message('one'), message('two')], 't', 3), snapshot: { ...transcriptSnapshot([message('one'), message('two')], 't', 3), starts: [0, 1] } });
  assert.equal(TranscriptReplica.receive(old, baseline([message('one')], 't', 1)), old);
  for (const snapshot of [
    { ...old.snapshot, revision: 4, messages: [message('replaced'), message('two')] },
    { ...old.snapshot, revision: 4, starts: [0] },
    { ...old.snapshot, revision: 3, end: 3, messages: [...old.snapshot.messages, message('unversioned')] },
    { ...old.snapshot, revision: 2, end: 3, messages: [...old.snapshot.messages, message('future')] },
  ])
    assert.throws(() => TranscriptReplica.receive(old, { type: 'baseline', snapshot }), TranscriptSequenceError);
});
