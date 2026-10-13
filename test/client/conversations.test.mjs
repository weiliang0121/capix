import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime, ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { baseline, conversationDescriptor, deferred, snapshot, submissionSnapshot, transcriptSnapshot } from './fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const input = { messages: [{ role: 'user', content: 'hello' }] };

async function fixture(t, options = {}) {
  const descriptors = new Map(['a', 'b', 'c'].map((id) => [id, conversationDescriptor(id, `transcript-${id}`)]));
  const streams = new Map();
  const observations = [];
  const posts = [];
  const conversation = {
    config: async () => ({ configured: true, model: 'fixture', contextBudget: 1024, maxOutputTokens: 128, timeoutMs: 1000 }),
    conversations: async () => ({ conversations: [...descriptors.values()], defaultConversationId: 'a' }),
    conversation: async (id) => descriptors.get(id),
    createConversation: async () => {
      const created = conversationDescriptor('new', 'transcript-new');
      descriptors.set(created.id, created);
      return created;
    },
    admission: async (id) => ({ conversationId: id, transcriptId: descriptors.get(id).transcriptId, status: 'ready' }),
    submit: async (request, receive, signal) => {
      posts.push({ request, receive, signal });
      await wait(signal);
    },
    ...options.conversation,
  };
  const runtime = new ClientRuntime({
    conversation,
    transcripts: {
      transcript: async () => assert.fail('opening requires a live stream baseline'),
      observeTranscript: async (id, receive, signal) => {
        streams.set(id, { receive, signal });
        if (options.transcript) await options.transcript(id, receive, signal);
        else receive({ type: 'baseline', snapshot: transcriptSnapshot([{ role: 'user', content: id }], id) });
        await wait(signal);
      },
    },
    observation: {
      execution: options.execution ?? (async (_conversationId, id) => snapshot('succeeded', id)),
      observe: async (id, receive, signal) => {
        observations.push({ id, receive, signal });
        if (options.observation) return options.observation(id, receive, signal);
        receive(baseline({ scopeId: id, transcript: { id: `transcript-${id}`, revision: 1, starts: [0] }, overview: { transcriptId: `transcript-${id}`, messages: [], executions: [] } }));
        await wait(signal);
      },
    },
  });
  t.after(() => {
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
  });
  await runtime.initialize();
  return { runtime, streams, observations, posts, descriptors };
}

test('switching keeps the old conversation visible until the target baseline is accepted, then changes all sources together', async (t) => {
  const gate = deferred();
  const f = await fixture(t, {
    transcript: async (id, receive) => {
      if (id === 'transcript-b') await gate.promise;
      receive({ type: 'baseline', snapshot: transcriptSnapshot([{ role: 'user', content: id }], id) });
    },
  });
  const stop = f.runtime.startObservation();
  t.after(stop);
  await settle();
  const oldObservation = f.observations[0];
  const opened = f.runtime.openConversation('b');
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'a');
  assert.equal(f.runtime.getSnapshot().switching, true);
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'transcript-a');
  assert.throws(() => f.runtime.enqueue(input), /初始化/);
  gate.resolve();
  await opened;
  await settle();
  const state = f.runtime.getSnapshot();
  assert.equal(state.conversation.id, 'b');
  assert.equal(state.transcriptId, 'transcript-b');
  assert.equal(state.messages[0].content, 'transcript-b');
  assert.equal(state.observation.overview.transcriptId, 'transcript-b');
  assert.equal(state.observation.cursor.scopeId, 'b');
  assert.equal(state.canSwitchConversation, true);
  assert.equal(f.streams.get('transcript-a').signal.aborted, true);
  assert.equal(oldObservation.signal.aborted, true);
  oldObservation.receive(baseline());
  await settle();
  assert.equal(f.runtime.getSnapshot().observation.cursor.scopeId, 'b');
});

test('failed opening retains the old target and queue commands still submit to that explicit conversation', async (t) => {
  const failure = new Error('target unavailable');
  const f = await fixture(t, {
    transcript: async (id, receive) => {
      if (id === 'transcript-b') throw failure;
      receive({ type: 'baseline', snapshot: transcriptSnapshot([], id) });
    },
  });
  await assert.rejects(f.runtime.openConversation('b'), (error) => error === failure);
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'a');
  assert.equal(f.runtime.getSnapshot().conversationError, failure);
  assert.equal(f.runtime.getSnapshot().switching, false);
  f.runtime.enqueue(input);
  await settle();
  assert.equal(f.posts[0].request.conversationId, 'a');
});

test('unknown submissions and waiting messages both block switching without cancelling or moving the queue', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(input);
  await assert.rejects(f.runtime.openConversation('b'), /待发送/);
  await assert.rejects(f.runtime.createConversation(), /当前不能/);
  await settle();
  await assert.rejects(f.runtime.openConversation('b'), /尚未结束/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].signal.aborted, false);
  const first = f.posts[0];
  first.receive(submissionSnapshot(first.request.submissionId, { conversationId: 'a', result: { status: 'completed' }, admission: { conversationId: 'a', transcriptId: 'transcript-a', status: 'ready' } }));
  await settle();
  await f.runtime.openConversation('b');
  f.runtime.enqueue(input);
  await settle();
  assert.equal(f.posts[1].request.conversationId, 'b');
  assert.equal(f.runtime.getSnapshot().submissions.size, 1);
  assert.equal(f.runtime.getSnapshot().submission.conversationId, 'b');
});

test('rapid opening changes ignore obsolete descriptors and cannot publish old content under a new title', async (t) => {
  const first = deferred();
  const f = await fixture(t, { conversation: { conversation: (id) => (id === 'b' ? first.promise : Promise.resolve(conversationDescriptor(id, `transcript-${id}`))) } });
  const old = f.runtime.openConversation('b');
  await f.runtime.openConversation('c');
  first.resolve(conversationDescriptor('b', 'transcript-b'));
  await old;
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'c');
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'transcript-c');
  assert.equal(f.streams.has('transcript-b'), false);
});

test('superseded target baseline is stopped while a second target opens', async (t) => {
  const waiting = deferred();
  const f = await fixture(t, {
    transcript: async (id, receive) => {
      if (id === 'transcript-b') await waiting.promise;
      receive({ type: 'baseline', snapshot: transcriptSnapshot([], id) });
    },
  });
  const first = f.runtime.openConversation('b');
  const discarded = assert.rejects(first, { name: 'AbortError' });
  await settle();
  await f.runtime.openConversation('c');
  await discarded;
  waiting.resolve();
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'c');
  assert.equal(f.runtime.getSnapshot().conversationError, undefined);
  assert.equal(f.streams.get('transcript-b').signal.aborted, true);
});

test('creating persists the new descriptor in the list and opens its own baseline', async (t) => {
  const f = await fixture(t);
  const created = await f.runtime.createConversation();
  await settle();
  assert.equal(created.id, 'new');
  assert.equal(f.runtime.getSnapshot().conversation.id, 'new');
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'transcript-new');
  assert.ok(f.runtime.getSnapshot().conversations.some((item) => item.id === 'new'));
});

test('optional observation failure does not veto a valid conversation opening', async (t) => {
  const failure = new Error('observation unavailable');
  const f = await fixture(t, {
    observation: async () => {
      throw failure;
    },
  });
  const stop = f.runtime.startObservation();
  t.after(stop);
  await f.runtime.openConversation('b');
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'b');
  assert.equal(f.runtime.getSnapshot().observation.error, failure);
  assert.equal(f.runtime.getSnapshot().canSwitchConversation, true);
});

test('an old pending detail cannot enter the next conversation cache', async (t) => {
  const detail = deferred();
  const f = await fixture(t, { execution: () => detail.promise });
  const pending = f.runtime.loadExecution('execution-1');
  const rejected = assert.rejects(pending, /忽略旧详情/);
  await f.runtime.openConversation('b');
  detail.resolve(snapshot());
  await rejected;
  assert.equal(f.runtime.getExecution('execution-1'), undefined);
});

test('submission rejects a different conversation even when all submission and transcript identities match', () => {
  const tracked = new ClientSubmission('a', input);
  assert.throws(() => tracked.receive(submissionSnapshot(tracked.id, { conversationId: 'b' })), SubmissionContractError);
  assert.throws(() => tracked.receive(submissionSnapshot(tracked.id, { conversationId: 'a', admission: { conversationId: 'b', transcriptId: 't', status: 'ready' } })), SubmissionContractError);
});

test('HTTP conversation targets are explicit and mismatched descriptors or admission responses are rejected', async () => {
  const calls = [];
  const descriptor = conversationDescriptor('a', 't');
  const http = new ConversationHttpTransport('', async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('/admission') ? { conversationId: 'a', transcriptId: 't', status: 'ready' } : descriptor);
  });
  assert.deepEqual(await http.createConversation(), descriptor);
  assert.equal(calls[0].url, '/api/conversations');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(await http.conversation('a'), descriptor);
  assert.equal(calls[1].url, '/api/conversations/a');
  await assert.rejects(http.conversation('b'), (error) => error.code === 'CONVERSATION_MISMATCH');
  await assert.rejects(http.admission('b'), (error) => error.code === 'CONVERSATION_MISMATCH');
  const observation = new ObservationHttpTransport('', async (url) => {
    calls.push({ url });
    return Response.json({ items: [] });
  });
  await observation.memory('a/b');
  assert.equal(calls.at(-1).url, '/api/memory?conversationId=a%2Fb');
});

test('stopping a pending opening restores the old target without clearing its content', async (t) => {
  const gate = deferred();
  const f = await fixture(t, {
    transcript: async (id, receive) => {
      if (id === 'transcript-b') await gate.promise;
      receive({ type: 'baseline', snapshot: transcriptSnapshot([{ role: 'user', content: id }], id) });
    },
  });
  const opening = f.runtime.openConversation('b');
  const stopped = assert.rejects(opening, { name: 'AbortError' });
  await settle();
  f.runtime.stopTranscript('transcript-b');
  await stopped;
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'a');
  assert.equal(f.runtime.getSnapshot().messages[0].content, 'transcript-a');
  assert.equal(f.runtime.getSnapshot().switching, false);
  gate.resolve();
});

test('a reentrant opening during old feedback shutdown supersedes the committing target and releases its stream', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(input);
  await settle();
  const post = f.posts[0];
  post.receive(submissionSnapshot(post.request.submissionId, { conversationId: 'a', result: { status: 'completed' } }));
  await settle();
  let replacement;
  post.signal.addEventListener(
    'abort',
    () => {
      replacement = f.runtime.openConversation('c');
    },
    { once: true },
  );
  await f.runtime.openConversation('b');
  await replacement;
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'c');
  assert.equal(f.streams.get('transcript-b').signal.aborted, true);
  assert.equal(f.streams.get('transcript-a').signal.aborted, true);
  assert.equal(f.streams.get('transcript-c').signal.aborted, false);
});

test('a catalog refresh started before creation cannot later remove the newly created conversation', async (t) => {
  const stale = deferred();
  let reads = 0;
  const f = await fixture(t, {
    conversation: {
      conversations: async () => {
        reads++;
        if (reads > 1) return stale.promise;
        return { conversations: [conversationDescriptor('a', 'transcript-a')], defaultConversationId: 'a' };
      },
    },
  });
  const refreshing = f.runtime.refreshConversations();
  await f.runtime.createConversation();
  stale.resolve({ conversations: [conversationDescriptor('a', 'transcript-a')], defaultConversationId: 'a' });
  await refreshing;
  await settle();
  assert.equal(f.runtime.getSnapshot().conversation.id, 'new');
  assert.ok(f.runtime.getSnapshot().conversations.some((item) => item.id === 'new'));
});
