import { Driver } from '@capix/server-runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ServerResponse } from 'node:http';
import { ConversationSubmission, createConversationStructure, ModelInteractions, ModelSource, ObserverConversations, buildConversation, createObserverServer } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const input = { messages: [{ role: 'user', content: 'question' }] };
const modelOutput = (value) => ({ id: 'fixture', model: 'fixture', content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', usage: null });
const nonAnswer = (purpose) => modelOutput(purpose === 'selection' ? { historyIndexes: [] } : { memories: [] });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
function complete(submission) {
  if (submission.snapshot.result) return Promise.resolve(submission.snapshot);
  return new Promise((resolve) => {
    const detach = submission.connect((value) => {
      if (!value.result) return;
      detach();
      resolve(value);
    });
  });
}
function event(submission, kind, sequence, extra = {}, source = { contextId: 'answer-call', round: 1 }) {
  submission.answerProgress.publish({ kind: 'generation', event: { kind, sequence, ...source, ...extra } });
}
function acceptInput(submission, transcriptId = 'transcript') {
  submission.progress.publish({ kind: 'input', range: { transcriptId, start: 0, end: 1 } });
}
function commit(submission, content, source = { contextId: 'answer-call', round: 1 }) {
  const message = { transcriptId: 'transcript', index: 1 };
  submission.progress.publish({ kind: 'answer', range: { transcriptId: message.transcriptId, start: message.index, end: message.index + 1 } });
  submission.answerProgress.publish({ kind: 'committed', source, message, content });
}
function bind(provider, environment = createEnvironment()) {
  const interactions = new ModelInteractions(new ModelSource(provider));
  const driver = new Driver();
  const scene = buildConversation(driver, createConversationStructure(), environment, interactions);
  const submission = new ConversationSubmission('stream', 'conversation');
  submission.start((signal) => driver.run(scene, input, { settings, signal, progress: submission.progress, answerProgress: submission.answerProgress }));
  return { environment, interactions, driver, scene, submission };
}

test('candidate reception is provisional; a matching explicit commit supplies the formal message locator', async () => {
  const submission = new ConversationSubmission('projection', 'conversation');
  acceptInput(submission);
  const frames = [];
  const detach = submission.connectFrames((frame) => {
    frames.push(frame);
  });
  event(submission, 'started', 1);
  event(submission, 'delta', 2, { delta: { text: 'prefix' } });
  event(submission, 'sealed', 3);
  event(submission, 'completed', 4, { result: { kind: 'answer', content: 'prefix tail' }, discarded: false });
  assert.equal(submission.baseline.preview.state, 'received');
  assert.equal(submission.snapshot.answer, undefined);
  commit(submission, 'prefix tail');
  submission.start(async () => {});
  await complete(submission);
  detach();
  assert.deepEqual(submission.baseline.preview, { generation: 1, revision: 4, state: 'committed', text: 'prefix', message: { transcriptId: 'transcript', index: 1 }, consistency: 'prefix' });
  assert.equal(submission.snapshot.result.status, 'completed');
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'answer').map((frame) => frame.change.kind),
    ['started', 'appended', 'received', 'committed'],
  );
  assert.ok(frames.filter((frame) => frame.type === 'answer').every((frame) => frame.submissionId === submission.id && frame.conversationId === submission.conversationId));
});

test('a rejected generation is discarded and the next local round starts a separate text candidate', async () => {
  const submission = new ConversationSubmission('regenerate', 'conversation');
  acceptInput(submission);
  event(submission, 'started', 1);
  event(submission, 'delta', 2, { delta: { text: 'discard me' } });
  event(submission, 'sealed', 3);
  event(submission, 'discarded', 4, { reason: 'exception' });
  const old = submission.baseline.preview;
  const source = { contextId: 'answer-call', round: 2 };
  event(submission, 'started', 1, {}, source);
  event(submission, 'delta', 2, { delta: { text: 'replacement' } }, source);
  event(submission, 'sealed', 3, {}, source);
  event(submission, 'completed', 4, { result: { kind: 'answer', content: 'replacement' }, discarded: false }, source);
  commit(submission, 'replacement', source);
  submission.start(async () => {});
  await complete(submission);
  assert.equal(old.state, 'discarded');
  assert.equal(old.reason, 'rejected');
  assert.equal(submission.baseline.preview.generation, 2);
  assert.equal(submission.baseline.preview.text, 'replacement');
  assert.equal(submission.baseline.preview.consistency, 'complete');
});

test('preview source or sequence failure disables that projection without changing authoritative completion', async () => {
  for (const invalid of [{ sequence: 3 }, { contextId: 'foreign' }]) {
    const submission = new ConversationSubmission('bad-preview', 'conversation');
    acceptInput(submission);
    event(submission, 'started', 1);
    submission.answerProgress.publish({ kind: 'generation', event: { kind: 'delta', contextId: 'answer-call', round: 1, sequence: 2, delta: { text: 'untrusted' }, ...invalid } });
    assert.ok(submission.answerProgress.failure);
    assert.equal(submission.baseline.preview.state, 'discarded');
    assert.equal(submission.baseline.preview.reason, 'failed');
    assert.equal(submission.baseline.preview.text, '');
    commit(submission, 'formal answer');
    submission.start(async () => {});
    await complete(submission);
    assert.equal(submission.snapshot.integrity.status, 'complete');
    assert.equal(submission.snapshot.result.status, 'completed');
    assert.equal(submission.snapshot.answer.index, 1);
  }
});

test('pending microtask overflow delivers one authoritative preview baseline without losing text', async () => {
  const submission = new ConversationSubmission('bounded-preview', 'conversation');
  acceptInput(submission);
  const frames = [];
  const detach = submission.connectFrames((frame) => {
    frames.push(frame);
  });
  event(submission, 'started', 1);
  for (let index = 0; index < 520; index++) event(submission, 'delta', index + 2, { delta: { text: 'x' } });
  await tick();
  detach();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].type, 'baseline');
  assert.equal(frames[1].preview.text, 'x'.repeat(520));
  assert.equal(frames[1].preview.revision, 521);
  assert.equal(submission.answerProgress.failure, undefined);
});

test('new connections receive the current draft and failing connection consumers do not stop its producer', async () => {
  const submission = new ConversationSubmission('connections', 'conversation');
  acceptInput(submission);
  event(submission, 'started', 1);
  event(submission, 'delta', 2, { delta: { text: 'already buffered' } });
  const received = [];
  submission.connectFrames(() => {
    throw new Error('lost connection');
  });
  const detach = submission.connectFrames((frame) => {
    received.push(frame);
  });
  assert.equal(received[0].type, 'baseline');
  assert.equal(received[0].preview.text, 'already buffered');
  await tick();
  event(submission, 'delta', 3, { delta: { text: ' plus live' } });
  await tick();
  detach();
  assert.equal(submission.baseline.preview.text, 'already buffered plus live');
  assert.equal(submission.answerProgress.failure, undefined);
  assert.equal(received.at(-1).change.text, ' plus live');
});

test('actual streaming output is visible before final feedback, but Transcript changes only after business acceptance', { timeout: 5000 }, async (t) => {
  const streamed = deferred();
  const release = deferred();
  t.after(release.resolve);
  const { submission, environment } = bind({
    async invoke(_request, purpose, _signal, progress) {
      if (purpose !== 'answer') return nonAnswer(purpose);
      progress.publish({ text: '{"kind":"answer","content":"visible' });
      streamed.resolve();
      await release.promise;
      progress.publish({ text: ' tail"}' });
      return modelOutput({ kind: 'answer', content: 'visible tail' });
    },
  });
  await streamed.promise;
  await tick();
  assert.equal(submission.baseline.preview.state, 'streaming');
  assert.equal(submission.baseline.preview.text, 'visible');
  assert.equal(environment.transcript.length, 1);
  assert.equal(submission.snapshot.answer, undefined);
  assert.equal(submission.snapshot.result, undefined);
  release.resolve();
  const result = await complete(submission);
  assert.equal(result.result.status, 'completed');
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.transcript.get(1).content, 'visible tail');
  assert.equal(submission.baseline.preview.state, 'committed');
  assert.equal(submission.baseline.preview.consistency, 'complete');
  assert.deepEqual(submission.baseline.preview.message, result.answer);
});

test('real generation retry replaces rejected draft, and failed memory cannot discard the accepted replacement', { timeout: 5000 }, async () => {
  let answers = 0;
  const { submission, environment } = bind({
    async invoke(_request, purpose, _signal, progress) {
      if (purpose === 'memory') throw new Error('memory failed');
      if (purpose !== 'answer') return nonAnswer(purpose);
      answers++;
      const content = answers === 1 ? '{"kind":"answer","content":"old"' : '{"kind":"answer","content":"new"}';
      progress.publish({ text: content });
      return modelOutput(content);
    },
  });
  const result = await complete(submission);
  assert.equal(answers, 2);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.answer.index, 1);
  assert.equal(environment.transcript.get(1).content, 'new');
  assert.equal(submission.baseline.preview.generation, 2);
  assert.equal(submission.baseline.preview.state, 'committed');
  assert.equal(submission.baseline.preview.text, 'new');
});

test('formal append failure discards a received candidate rather than inventing a message association', { timeout: 5000 }, async () => {
  const environment = createEnvironment();
  const original = environment.transcript.appendFrom.bind(environment.transcript);
  environment.transcript.appendFrom = (messages, options) => {
    if (messages.some((message) => message.role === 'assistant')) throw new Error('formal append failed');
    return original(messages, options);
  };
  const { submission } = bind(
    {
      async invoke(_request, purpose, _signal, progress) {
        if (purpose !== 'answer') return nonAnswer(purpose);
        progress.publish({ text: '{"kind":"answer","content":"not saved"}' });
        return modelOutput({ kind: 'answer', content: 'not saved' });
      },
    },
    environment,
  );
  const result = await complete(submission);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.answer, undefined);
  assert.equal(environment.transcript.length, 1);
  assert.equal(submission.baseline.preview.state, 'discarded');
  assert.equal(submission.baseline.preview.message, undefined);
});

test('HTTP backpressure resumes with a complete baseline and never reruns model work', { timeout: 5000 }, async (t) => {
  const blocked = deferred();
  const begin = deferred();
  const release = deferred();
  let blockedResponse;
  let answerCalls = 0;
  let tracked;
  const originalStart = ConversationSubmission.prototype.start;
  t.mock.method(ConversationSubmission.prototype, 'start', function (work) {
    tracked = this;
    return originalStart.call(this, work);
  });
  const originalWrite = ServerResponse.prototype.write;
  t.mock.method(ServerResponse.prototype, 'write', function (chunk, ...args) {
    const accepted = originalWrite.call(this, chunk, ...args);
    if (!blockedResponse && this.req.url === '/api/run') {
      const frame = JSON.parse(String(chunk));
      if (frame.type === 'answer' && frame.change.kind === 'appended') {
        blockedResponse = this;
        blocked.resolve();
        return false;
      }
    }
    return accepted;
  });
  const host = new ObserverConversations({
    async invoke(_request, purpose, _signal, progress) {
      if (purpose !== 'answer') return nonAnswer(purpose);
      answerCalls++;
      await begin.promise;
      progress.publish({ text: '{"kind":"answer","content":"first' });
      await release.promise;
      progress.publish({ text: ' second' });
      await tick();
      progress.publish({ text: ' third"}' });
      return modelOutput({ kind: 'answer', content: 'first second third' });
    },
  });
  const server = createObserverServer({ conversations: host, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    begin.resolve();
    release.resolve();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    host.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const conversationId = host.list().defaultConversationId;
  const response = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, submissionId: 'slow', input }) });
  const reading = response.text();
  begin.resolve();
  await blocked.promise;
  release.resolve();
  await complete(tracked);
  await tick();
  blockedResponse.emit('drain');
  const frames = (await reading).trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].type, 'baseline');
  assert.ok(frames.some((frame) => frame.type === 'answer' && frame.change.text === 'first'));
  const final = frames.at(-1);
  assert.equal(final.type, 'baseline');
  assert.equal(final.submission.result.status, 'completed');
  assert.equal(final.preview.text, 'first second third');
  assert.equal(final.preview.state, 'committed');
  assert.equal(final.preview.consistency, 'complete');
  assert.equal(answerCalls, 1);
  const queried = await (await fetch(`${base}/api/submissions/slow`)).json();
  assert.deepEqual(queried, final);
});
