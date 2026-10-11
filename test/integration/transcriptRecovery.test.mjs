import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { initializeObserver, createObserverServer } from '@capix/observer-service';
import { ClientRuntime, TranscriptConnectionError } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
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

test('HTTP: transcript reconnect catches up a committed answer without repeating submission or model work', async (t) => {
  const answer = deferred();
  const reconnect = deferred();
  let answerCalls = 0;
  const environment = initializeObserver({
    async invoke(_request, purpose) {
      if (purpose === 'selection') return output({ historyIndexes: [] });
      if (purpose === 'memory') return output({ memories: [] });
      answerCalls++;
      await answer.promise;
      return output({ kind: 'answer', content: 'answer committed while message connection was offline' });
    },
  });
  const server = createObserverServer({ observer: environment, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const posts = [];
  const connections = [];
  const interrupted = new TypeError('fixture message connection disconnected');
  let interrupt;
  const transport = new ConversationHttpTransport(base, async (url, init) => {
    const path = new URL(url);
    if (path.pathname === '/api/run') posts.push(JSON.parse(init.body));
    if (path.pathname !== '/api/transcript/observe') return fetch(url, init);
    connections.push({ id: path.searchParams.get('id'), startedAt: Date.now() });
    if (connections.length > 1) {
      // Preserve the real receiver's retry delay, while making the assertion at
      // the independent completion boundary deterministic under a loaded runner.
      await reconnect.promise;
      return fetch(url, init);
    }
    const response = await fetch(url, init);
    const body = response.body.pipeThrough(
      new TransformStream({
        start(controller) {
          interrupt = () => controller.error(interrupted);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  const runtime = new ClientRuntime({ conversation: transport, transcripts: transport });
  t.after(async () => {
    answer.resolve();
    reconnect.resolve();
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await runtime.initialize();
  const id = runtime.getSnapshot().transcriptId;
  runtime.enqueue({ messages: [{ role: 'user', content: 'question before disconnect' }] });
  await until(() => answerCalls === 1 && runtime.getSnapshot().messages.length === 1);
  const messages = runtime.getSnapshot().messages;
  const interruptedAt = Date.now();
  interrupt();
  await until(() => runtime.getSnapshot().transcripts.get(id).sync.status === 'retrying');
  const disconnected = runtime.getSnapshot();
  assert.equal(disconnected.messages, messages, 'the accepted input remains available during reconnect');
  assert.ok(disconnected.transcripts.get(id).sync.error instanceof TranscriptConnectionError);
  assert.equal(disconnected.transcripts.get(id).sync.error.cause, interrupted);
  assert.equal(disconnected.submission.remote.result, undefined);

  answer.resolve();
  await until(() => runtime.getSnapshot().submission?.remote?.result?.status === 'completed');
  const completed = runtime.getSnapshot();
  assert.equal(completed.answered, true, 'feedback confirms the answer independently of its body');
  assert.equal(completed.answerAvailability, 'pending');
  assert.equal(completed.messages, messages);
  assert.deepEqual(
    environment.transcript.snapshot().map((message) => message.content),
    ['question before disconnect', 'answer committed while message connection was offline'],
  );
  assert.equal(posts.length, 1);
  assert.equal(answerCalls, 1);

  reconnect.resolve();
  await until(() => runtime.getSnapshot().transcripts.get(id).sync.status === 'live' && runtime.getSnapshot().answerAvailability === 'available');
  const recovered = runtime.getSnapshot();
  assert.equal(connections.length, 2);
  assert.equal(connections[0].id, null);
  assert.equal(connections[1].id, id, 'recovery stays bound to the original entity');
  assert.ok(connections[1].startedAt - interruptedAt >= 450, 'recovery observes the real 500 ms backoff');
  assert.deepEqual(
    recovered.messages.map((message) => message.content),
    ['question before disconnect', 'answer committed while message connection was offline'],
  );
  assert.deepEqual(recovered.submission.remote, completed.submission.remote, 'body catch-up does not rewrite remote execution facts');
  assert.equal(posts.length, 1, 'recovery never submits the question again');
  assert.equal(answerCalls, 1, 'recovery never generates the answer again');
});
