import test from 'node:test';

import assert from 'node:assert/strict';

import { ClientRuntime, TranscriptReplica, TranscriptSequenceError, TranscriptConnectionError } from '@capix/client-runtime';

import { conversationDescriptor, deferred, transcriptSnapshot, submissionDelivery } from './fixtures.mjs';

const message = (content, role = 'user') => ({ role, content });

const appended = (id, revision, start, messages) => ({ type: 'delta', event: { type: 'transcript', transcriptId: id, revision, occurredAt: '2026-10-09T00:00:00Z', origin: { contextId: 'context' }, change: { kind: 'messages-appended', start, messages } } });

const wait = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

const settle = () => new Promise((resolve) => setImmediate(resolve));

const conversations = async () => ({ conversations: [conversationDescriptor('fixture-conversation', 't')], defaultConversationId: 'fixture-conversation' });

const config = async () => ({ configured: true, model: 'fixture', contextBudget: 1000, maxOutputTokens: 100, timeoutMs: 1000 });

test('entity receiving preserves identity, exact revision, fixed prefixes and segment changes', () => {
  const first = TranscriptReplica.receive(undefined, { type: 'baseline', snapshot: transcriptSnapshot([message('one')], 't', 3) }, 't');
  const second = TranscriptReplica.receive(first, appended('t', 4, 1, [message('two')]));
  assert.equal(first.snapshot.end, 1);
  assert.equal(second.snapshot.end, 2);
  assert.equal(TranscriptReplica.receive(second, appended('t', 4, 1, [message('two')])), second);
  assert.throws(() => TranscriptReplica.receive(second, appended('other', 5, 2, [message('wrong')])), TranscriptSequenceError);
  assert.throws(() => TranscriptReplica.receive(second, appended('t', 6, 2, [message('gap')])), TranscriptSequenceError);
  assert.throws(() => TranscriptReplica.receive(second, appended('t', 5, 1, [message('overlap')])), TranscriptSequenceError);
  const segment = TranscriptReplica.receive(second, { type: 'delta', event: { type: 'transcript', transcriptId: 't', revision: 5, occurredAt: 'now', change: { kind: 'segment-started', previousStart: 0, start: 1, end: 2 } } });
  assert.deepEqual(segment.snapshot.starts, [0, 1]);
  assert.equal(segment.snapshot.messages, second.snapshot.messages);
  assert.throws(() => TranscriptReplica.receive(undefined, { type: 'baseline', snapshot: { ...transcriptSnapshot(), end: 10 } }), TranscriptSequenceError);
});

test('conversation and entity streams may arrive in either order without duplicating content or querying healthy copies', async () => {
  let emit;
  let reads = 0;
  const gate = deferred();
  const transcripts = {
    transcript: async () => {
      reads++;
      throw new Error('healthy copy needs no query');
    },
    observeTranscript: async (_id, accept, signal) => {
      emit = accept;
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 't', 0) });
      await wait(signal);
    },
  };
  const runtime = new ClientRuntime({
    transcripts,
    conversation: {
      activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }),
      conversations,
      config,
      submit: async (request, accept) => {
        emit(appended('t', 1, 0, [message('question')]));
        const delivery = submissionDelivery(request, accept);
        delivery.input({ transcriptId: 't', start: 0, end: 1 });
        delivery.execution('context');
        delivery.answer();
        emit(appended('t', 2, 1, [message('answer', 'assistant')]));
        await gate.promise;
        delivery.complete();
      },
    },
  });
  await runtime.initialize();
  const work = runtime.submit({ messages: [message('question')] });
  await settle();
  assert.equal(runtime.getSnapshot().busy, true);
  assert.equal(runtime.getSnapshot().answered, true);
  assert.deepEqual(runtime.getSnapshot().messages, [message('question'), message('answer', 'assistant')]);
  gate.resolve();
  await work;
  assert.equal(reads, 0);
  assert.equal(runtime.getSnapshot().transcripts.get('t').snapshot.revision, 2);
  runtime.stopTranscript();
});

test('repeated revision gaps exhaust bounded recovery and remain visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connections = 0;
  const transcripts = {
    transcript: async () => transcriptSnapshot(),
    observeTranscript: async (_id, accept) => {
      connections++;
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 't', connections === 1 ? 0 : 4) });
      await settle();
      accept(appended('t', connections === 1 ? 3 : 7, 0, [message('gap')]));
    },
  };
  const runtime = new ClientRuntime({ transcripts, conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }), conversations, config, submit: async () => {} } });
  await runtime.initialize();
  await settle();
  await settle();
  await settle();
  for (const delay of [500, 1500, 4000]) {
    t.mock.timers.tick(delay);
    await settle();
    await settle();
  }
  assert.equal(connections, 4);
  assert.equal(runtime.getSnapshot().transcripts.get('t').sync.status, 'failed');
  assert.ok(runtime.getSnapshot().transcripts.get('t').sync.error instanceof TranscriptSequenceError);
  assert.equal(runtime.getSnapshot().messages.length, 0);
});

test('entities load on demand, keep independent copies, and resume from a new baseline after stop', async () => {
  const connections = [];
  const emit = new Map();
  const transcripts = {
    transcript: async () => transcriptSnapshot(),
    observeTranscript: async (id = 'current', accept, signal) => {
      connections.push(id);
      emit.set(id, accept);
      accept({ type: 'baseline', snapshot: transcriptSnapshot([message(id)], id) });
      await wait(signal);
    },
  };
  const runtime = new ClientRuntime({ transcripts, conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 'current' }), conversations: async () => ({ conversations: [conversationDescriptor('fixture-conversation', 'current')], defaultConversationId: 'fixture-conversation' }), config, submit: async () => {} } });
  await runtime.initialize();
  assert.deepEqual(connections, ['current']);
  assert.equal(runtime.getSnapshot().transcripts.has('old'), false);
  await runtime.loadTranscript('old');
  await runtime.loadTranscript('old');
  assert.deepEqual(connections, ['current', 'old']);
  emit.get('old')(appended('old', 2, 1, [message('next')]));
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().transcripts.get('old').snapshot.end, 2);
  assert.equal(runtime.getSnapshot().messages.length, 1);
  runtime.stopTranscript('old');
  await runtime.loadTranscript('old');
  assert.deepEqual(connections, ['current', 'old', 'old']);
  assert.equal(runtime.getSnapshot().transcripts.get('old').snapshot.end, 2, 'a stale new baseline does not regress the existing copy');
  runtime.stopTranscript();
});

test('slow configuration initialization cannot overwrite newer entity deltas with the first baseline', async () => {
  const configuration = deferred();
  let emit;
  const runtime = new ClientRuntime({
    conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }), conversations, config: () => configuration.promise, submit: async () => {} },
    transcripts: {
      transcript: async () => transcriptSnapshot(),
      observeTranscript: async (_id, accept, signal) => {
        emit = accept;
        accept({ type: 'baseline', snapshot: transcriptSnapshot([], 't', 0) });
        await wait(signal);
      },
    },
  });
  const initialization = runtime.initialize();
  await settle();
  emit(appended('t', 1, 0, [message('arrived before config')]));
  configuration.resolve(await config());
  await initialization;
  assert.equal(runtime.getSnapshot().messages[0].content, 'arrived before config');
  assert.equal(runtime.getSnapshot().messages, runtime.getSnapshot().transcripts.get('t').snapshot.messages);
  runtime.stopTranscript();
});

test('initialization and explicit UID subscription share the same entity connection', async () => {
  const callbacks = new Map();
  const signals = new Map();
  const runtime = new ClientRuntime({
    conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }), conversations, config, submit: async () => {} },
    transcripts: {
      transcript: async () => transcriptSnapshot(),
      observeTranscript: async (id, accept, signal) => {
        callbacks.set(id, accept);
        signals.set(id, signal);
        await wait(signal);
      },
    },
  });
  const initial = runtime.initialize();
  const requested = runtime.loadTranscript('t');
  await settle();
  callbacks.get('t')({ type: 'baseline', snapshot: transcriptSnapshot([], 't') });
  assert.equal((await requested).id, 't');
  await initial;
  assert.equal(signals.size, 1);
  assert.equal(signals.get('t').aborted, false);
  callbacks.get('t')(appended('t', 1, 0, [message('current')]));
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().messages[0].content, 'current');
  runtime.stopTranscript();
});

test('a network disconnect obtains a new baseline after backoff and never retries business execution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connections = 0;
  const runtime = new ClientRuntime({
    conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }), conversations, config, submit: async () => assert.fail('not a business retry') },
    transcripts: {
      transcript: async () => transcriptSnapshot(),
      observeTranscript: async (_id, accept, signal) => {
        connections++;
        if (connections === 1) throw new TranscriptConnectionError('network disconnected');
        accept({ type: 'baseline', snapshot: transcriptSnapshot([message('fresh')], 't') });
        await wait(signal);
      },
    },
  });
  const initial = runtime.initialize();
  await settle();
  assert.equal(connections, 1);
  t.mock.timers.tick(500);
  await initial;
  assert.equal(connections, 2);
  assert.equal(runtime.getSnapshot().messages[0].content, 'fresh');
  runtime.stopTranscript();
});

test('a throwing UI subscriber is detached without terminating entity sync or starving other consumers', async () => {
  let emit;
  const runtime = new ClientRuntime({
    conversation: { activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }), conversations, config, submit: async () => {} },
    transcripts: {
      transcript: async () => transcriptSnapshot(),
      observeTranscript: async (_id, accept, signal) => {
        emit = accept;
        accept({ type: 'baseline', snapshot: transcriptSnapshot([], 't', 0) });
        await wait(signal);
      },
    },
  });
  let failingCalls = 0;
  let healthyCalls = 0;
  runtime.subscribe(() => {
    failingCalls++;
    throw new Error('view failed');
  });
  runtime.subscribe(() => {
    healthyCalls++;
  });
  await runtime.initialize();
  emit(appended('t', 1, 0, [message('first')]));
  emit(appended('t', 2, 1, [message('second')]));
  await Promise.resolve();
  assert.equal(failingCalls, 1);
  assert.ok(healthyCalls >= 3);
  assert.equal(runtime.getSnapshot().messages.length, 2);
  assert.equal(runtime.getSnapshot().transcripts.get('t').sync.status, 'live');
  assert.equal(runtime.getSnapshot().transcripts.get('t').sync.error, undefined);
  runtime.stopTranscript();
});

test('answer locators can precede their separately synchronized entity without inventing content', async () => {
  let emit;
  const runtime = new ClientRuntime({
    conversation: {
      activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: 't' }),
      conversations,
      config,
      submit: async (request, accept) => {
        const delivery = submissionDelivery(request, accept);
        delivery.input({ transcriptId: 't', start: 0, end: 1 });
        delivery.execution('context');
        delivery.answer();
        delivery.complete();
      },
    },
    transcripts: {
      transcript: async () => assert.fail('healthy stream needs no query'),
      observeTranscript: async (_id, accept, signal) => {
        emit = accept;
        accept({ type: 'baseline', snapshot: transcriptSnapshot([], 't', 0) });
        await wait(signal);
      },
    },
  });
  await runtime.initialize();
  await runtime.submit({ messages: [message('question')] });
  assert.equal(runtime.getSnapshot().messages.length, 0);
  assert.equal(runtime.getSnapshot().submission.remote.answer.index, 1);
  emit(appended('t', 1, 0, [message('question'), message('independently delivered', 'assistant')]));
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().messages[1].content, 'independently delivered');
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  runtime.stopTranscript();
});
