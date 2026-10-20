import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ObserverConversations, createObserverServer, ConversationSubmission } from '@capix/observer-service';
import { ClientSubmission } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
const input = { messages: [{ role: 'user', content: 'question' }] };
const client = () => new ClientSubmission('conversation', input);
const started = (contextId, parentContextId, kind, eventSequence = 1) => ({ kind: 'started', eventSequence, identity: { contextId, ...(parentContextId ? { parentContextId } : {}), kind }, occurredAt: '2026-10-01T00:00:00Z' });

function generation(service, kind, sequence, extra = {}) {
  service.answerProgress.publish({ kind: 'generation', event: { kind, sequence, contextId: 'answer', round: 1, ...extra } });
}

test('real submission producers preserve clients across pending subscription and reentrant query baselines', async () => {
  const first = client();
  const service = new ConversationSubmission(first.id, first.conversationId);
  service.connectFrames((frame) => first.receiveFrame(frame));
  service.progress.publish({ kind: 'input', range: { transcriptId: 't', start: 0, end: 1 } });
  service.activity.publish(started('r', undefined, 'scene'));
  const frames = [];
  service.connectFrames((frame) => {
    frames.push(frame);
  });
  service.activity.publish(started('e', 'r', 'group'));
  service.progress.publish({ kind: 'execution', contextId: 'e' });
  let reentered = false;
  service.connectFrames((frame) => {
    if (frame.type !== 'submission' || reentered) return;
    reentered = true;
    service.requestCancellation();
    first.receiveFrame(service.baseline);
  });
  service.connectFrames(() => {
    throw new Error('optional consumer failed');
  });
  await tick();
  await tick();
  assert.equal(first.snapshot.remote.cancelRequested, undefined, 'a covered subscription does not receive old changes');
  service.progress.publish({ kind: 'task', task: { kind: 'reply' } });
  await tick();
  await tick();
  assert.equal(reentered, true);
  assert.deepEqual(first.snapshot.remote, service.snapshot);
  assert.equal(service.activity.failure, undefined);
  assert.equal(service.progress.failure, undefined);
  assert.equal(frames.filter((frame) => frame.type === 'baseline').length, 1);
  assert.ok(frames.some((frame) => frame.type === 'submission'));
});

test('mock provider streams through real HTTP change frames into the client without a second model request', { timeout: 5000 }, async (context) => {
  let answerCalls = 0;
  const host = new ObserverConversations({
    async invoke(_request, purpose, _signal, progress) {
      if (purpose === 'selection') return output({ historyIndexes: [] });
      if (purpose === 'memory') return output({ memories: [] });
      answerCalls++;
      progress.publish({ text: '{"kind":"answer","content":"first' });
      await tick();
      progress.publish({ text: ' second"}' });
      return output({ kind: 'answer', content: 'first second' });
    },
  });
  const server = createObserverServer({ conversations: host, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    host.close();
  });
  const conversationId = host.list().defaultConversationId;
  const submission = new ClientSubmission(conversationId, input);
  const http = new ConversationHttpTransport(`http://127.0.0.1:${server.address().port}`);
  const frames = [];
  await http.submit(
    { conversationId, submissionId: submission.id, input },
    (frame) => {
      frames.push(frame);
      submission.receiveFrame(frame);
    },
    new AbortController().signal,
  );
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.remote.integrity.status, 'complete');
  assert.equal(submission.snapshot.remote.activities.integrity.status, 'complete');
  assert.equal(submission.snapshot.preview.status, 'live');
  assert.equal(submission.snapshot.preview.snapshot.state, 'committed');
  assert.equal(submission.snapshot.preview.snapshot.text, 'first second');
  assert.equal(answerCalls, 1);
  assert.equal(frames[0].type, 'baseline');
  assert.ok(frames.some((frame) => frame.type === 'submission' && frame.change.activities?.calls?.length));
  assert.ok(frames.some((frame) => frame.type === 'answer'));
  assert.ok(frames.filter((frame) => frame.type === 'submission').every((frame) => frame.submission === undefined));
  const queried = await http.read(submission.id);
  submission.receiveFrame(queried);
  assert.deepEqual(submission.snapshot.remote, queried.submission);
});

test('a subscription established before input accepts a synchronous preview commit before its formal change frame', async () => {
  const received = client();
  const service = new ConversationSubmission(received.id, received.conversationId);
  service.connectFrames((frame) => received.receiveFrame(frame));
  service.progress.publish({ kind: 'input', range: { transcriptId: 't', start: 0, end: 1 } });
  generation(service, 'started', 1);
  generation(service, 'delta', 2, { delta: { text: 'answer' } });
  generation(service, 'sealed', 3);
  generation(service, 'completed', 4, { result: { kind: 'answer', content: 'answer' }, discarded: false });
  service.progress.publish({ kind: 'answer', range: { transcriptId: 't', start: 1, end: 2 } });
  service.answerProgress.publish({ kind: 'committed', source: { contextId: 'answer', round: 1 }, message: { transcriptId: 't', index: 1 }, content: 'answer' });
  service.start(async () => {});
  await tick();
  await tick();
  assert.equal(received.snapshot.preview.status, 'live');
  assert.equal(received.snapshot.preview.snapshot.state, 'committed');
  assert.equal(received.snapshot.remote.result.status, 'completed');
  assert.deepEqual(received.snapshot.remote, service.snapshot);
});

test('deferred preview association still rejects later transcript conflicts and complete terminal facts missing formal locators', async () => {
  for (const mode of ['foreign-transcript', 'missing-input', 'missing-answer']) {
    const received = client();
    const service = new ConversationSubmission(received.id, received.conversationId);
    service.connectFrames((frame) => received.receiveFrame(frame));
    generation(service, 'started', 1);
    generation(service, 'delta', 2, { delta: { text: 'answer' } });
    generation(service, 'sealed', 3);
    generation(service, 'completed', 4, { result: { kind: 'answer', content: 'answer' }, discarded: false });
    service.answerProgress.publish({ kind: 'committed', source: { contextId: 'answer', round: 1 }, message: { transcriptId: 't', index: 1 }, content: 'answer' });
    await tick();
    assert.equal(received.snapshot.preview.status, 'live', 'missing input remains provisional until formal facts arrive');
    if (mode !== 'missing-input') service.progress.publish({ kind: 'input', range: { transcriptId: mode === 'foreign-transcript' ? 'foreign' : 't', start: 0, end: 1 } });
    service.start(async () => {});
    await tick();
    await tick();
    assert.equal(received.snapshot.preview.status, 'failed');
    assert.equal(received.snapshot.remote.result.status, 'completed', 'preview rejection never changes formal business result');
    assert.equal(received.snapshot.remote.integrity.status, 'complete');
  }
});
