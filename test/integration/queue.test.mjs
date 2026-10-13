import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ObserverConversations, createObserverServer } from '@capix/observer-service';
import { ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const input = (content) => ({ messages: [{ role: 'user', content }] });
const output = (value, finishReason = 'stop') => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason, usage: null });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'expected lifecycle boundary was not reached');
}
async function fixture(t, answer, options = {}) {
  let calls = 0;
  const conversations = new ObserverConversations(
    options.initialize ?? {
      async invoke(_request, purpose, signal) {
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') return output({ memories: [] });
        return answer(++calls, signal);
      },
    },
  );
  const conversationId = conversations.list().defaultConversationId;
  const environment = conversations.open(conversationId);
  const server = createObserverServer({ conversations, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const posts = [];
  const transport = new ConversationHttpTransport(base, (url, init) => {
    if (new URL(url).pathname === '/api/run') posts.push(JSON.parse(init.body));
    return fetch(url, init);
  });
  const conversation = options.transport ? options.transport(transport, environment) : transport;
  const runtime = new ClientRuntime({ conversation, transcripts: transport });
  t.after(async () => {
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    conversations.close();
  });
  await runtime.initialize();
  return {
    runtime,
    environment,
    transport,
    conversationId,
    posts,
    get calls() {
      return calls;
    },
  };
}

test('HTTP: incomplete model output ends one QA and automatically advances waiting messages in order', async (t) => {
  const gate = deferred();
  const f = await fixture(t, async (number) => {
    if (number === 1) {
      await gate.promise;
      return output({ kind: 'answer', content: 'incomplete' }, 'length');
    }
    return output({ kind: 'answer', content: `answer ${number}` });
  });
  f.runtime.enqueue(input('first'));
  await until(() => f.calls === 1);
  f.runtime.enqueue(input('second'));
  f.runtime.enqueue(input('first again'));
  gate.resolve();
  await until(() => f.runtime.getSnapshot().submission?.remote?.result?.status === 'completed' && f.posts.length === 3);
  await until(() => f.runtime.getSnapshot().messages.length === 5);
  assert.deepEqual(
    f.posts.map((request) => request.input.messages[0].content),
    ['first', 'second', 'first again'],
  );
  assert.deepEqual(
    f.runtime.getSnapshot().messages.map((message) => message.content),
    ['first', 'second', 'answer 2', 'first again', 'answer 3'],
  );
  const first = [...f.runtime.getSnapshot().submissions.values()][0];
  assert.equal(first.remote.result.error.code, 'INCOMPLETE_OUTPUT');
  assert.equal(first.remote.admission.status, 'ready');
  assert.equal(f.calls, 3, 'the failed model call itself was not retried');
  assert.equal(f.runtime.getSnapshot().queue.waiting.length, 0);
});

test('HTTP: readiness racing another caller retains the same waiting item and retries admission with a fresh POST identity', async (t) => {
  const gate = deferred();
  let reserve;
  let raced = false;
  const f = await fixture(t, async () => output({ kind: 'answer', content: 'answer' }), {
    transport: (io, environment) => ({
      config: () => io.config(),
      conversations: (signal) => io.conversations(signal),
      conversation: (id, signal) => io.conversation(id, signal),
      createConversation: (signal) => io.createConversation(signal),
      admission: (id, signal) => io.admission(id, signal),
      read: (id, signal) => io.read(id, signal),
      follow: (id, receive, signal) => io.follow(id, receive, signal),
      cancel: (id, signal) => io.cancel(id, signal),
      submit: (request, receive, signal) => {
        if (!raced) {
          raced = true;
          reserve = environment.runtime.reserve(() => gate.promise);
        }
        return io.submit(request, receive, signal);
      },
    }),
  });
  const local = f.runtime.enqueue(input('retained question'));
  const later = f.runtime.enqueue(input('withdraw this'));
  await until(() => f.runtime.getSnapshot().submission?.remote?.result?.retry === 'admission');
  assert.equal(f.environment.transcript.length, 0, 'busy rejection did not append input');
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [local.id, later.id],
  );
  await f.runtime.cancelSubmission(later.id);
  gate.resolve();
  await reserve;
  await until(() => f.runtime.getSnapshot().submission?.remote?.result?.status === 'completed');
  assert.equal(f.posts.length, 2);
  assert.notEqual(f.posts[0].submissionId, f.posts[1].submissionId);
  assert.deepEqual(f.posts[0].input, f.posts[1].input);
  assert.equal(f.runtime.getSnapshot().submission.queueId, local.id);
  assert.deepEqual(
    f.environment.transcript.snapshot().map((message) => message.content),
    ['retained question', 'answer'],
  );
});

test('HTTP: lost feedback follows the original submission, without reposting it or consuming the next item early', async (t) => {
  const gate = deferred();
  const reads = [];
  let interrupted = false;
  const f = await fixture(
    t,
    async (number) => {
      if (number === 1) await gate.promise;
      return output({ kind: 'answer', content: `answer ${number}` });
    },
    {
      transport: (io) => ({
        config: () => io.config(),
        conversations: (signal) => io.conversations(signal),
        conversation: (id, signal) => io.conversation(id, signal),
        createConversation: (signal) => io.createConversation(signal),
        admission: (id, signal) => io.admission(id, signal),
        read: (id, signal) => {
          reads.push(id);
          return io.read(id, signal);
        },
        follow: (id, receive, signal) => {
          reads.push(id);
          return io.follow(id, receive, signal);
        },
        cancel: (id, signal) => io.cancel(id, signal),
        submit: (request, receive, signal) =>
          io.submit(
            request,
            (frame) => {
              receive(frame);
              const progress = frame.type === 'baseline' ? frame.submission : frame.type === 'submission' ? frame.change : undefined;
              if (!interrupted && progress?.input && !progress.result) {
                interrupted = true;
                throw new Error('test feedback consumer lost its connection');
              }
            },
            signal,
          ),
      }),
    },
  );
  f.runtime.enqueue(input('first'));
  f.runtime.enqueue(input('second'));
  await until(() => interrupted && reads.length > 0);
  assert.equal(f.posts.length, 1);
  assert.ok(reads.every((id) => id === f.posts[0].submissionId));
  gate.resolve();
  await until(() => f.posts.length === 2 && f.runtime.getSnapshot().submission?.remote?.result?.status === 'completed');
  assert.equal(new Set(f.posts.map((request) => request.submissionId)).size, 2);
  assert.equal(f.calls, 2);
});

test('HTTP: cancelling the active answer preserves input and automatically processes the remaining queue after actual exit', async (t) => {
  const f = await fixture(t, async (number, signal) => {
    if (number === 1)
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    return output({ kind: 'answer', content: 'next answer' });
  });
  const first = f.runtime.enqueue(input('cancel this'));
  f.runtime.enqueue(input('keep this'));
  await until(() => f.calls === 1);
  await f.runtime.cancelSubmission(first.id);
  await until(() => f.posts.length === 2 && f.runtime.getSnapshot().submission?.remote?.result?.status === 'completed');
  assert.equal([...f.runtime.getSnapshot().submissions.values()][0].remote.result.status, 'cancelled');
  assert.deepEqual(
    f.environment.transcript.snapshot().map((message) => message.content),
    ['cancel this', 'keep this', 'next answer'],
  );
});

test('HTTP: a known model initialization failure blocks admission without draining or discarding waiting input', async (t) => {
  let initialized = 0;
  const f = await fixture(t, undefined, {
    initialize: () => {
      initialized++;
      throw new Error('fixture model initialization failed');
    },
  });
  assert.equal((await f.transport.admission(f.conversationId)).status, 'ready');
  assert.equal(initialized, 0, 'checking admission must preserve lazy model construction');
  f.runtime.enqueue(input('first'));
  const second = f.runtime.enqueue(input('keep waiting'));
  await until(() => f.runtime.getSnapshot().submission?.remote?.result?.status === 'failed');
  const admission = await f.transport.admission(f.conversationId);
  assert.equal(admission.status, 'unavailable');
  assert.equal(admission.error.code, 'MODEL_INITIALIZATION_FAILED');
  await until(() => Boolean(f.runtime.getSnapshot().queue.blocked));
  assert.equal(f.posts.length, 1);
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [second.id],
  );
  assert.equal(initialized, 1);
  await f.runtime.cancelSubmission(second.id);
  assert.equal(f.runtime.getSnapshot().queue.waiting.length, 0);
});
