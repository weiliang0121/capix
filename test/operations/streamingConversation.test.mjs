import { Driver } from '@capix/server-runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindConversation, ConversationSceneDefinition, ConversationSubmission, ModelInteractions, ModelSource, WorkspaceFiles } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 2000 };
const envelope = (value) => ({ id: 'fixture', model: 'fixture', content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', usage: null });
const input = { messages: [{ role: 'user', content: '请回答问题' }] };

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fixture(t, answer, options = {}) {
  const environment = createEnvironment();
  const calls = [];
  const interactions = new ModelInteractions(
    new ModelSource({
      invoke: async (request, purpose, signal, progress) => {
        calls.push({ request, purpose });
        if (purpose === 'selection') return envelope({ historyIndexes: [] });
        if (purpose === 'memory') return envelope(options.memoryFailure ? 'invalid memory JSON' : { memories: [] });
        if (purpose === 'understanding') return envelope({ kind: 'reply' });
        assert.equal(request.stream, true);
        assert.ok(progress);
        return answer({ request, signal, progress, attempt: calls.filter((call) => call.purpose === 'answer').length });
      },
    }),
  );
  const driver = new Driver();
  const scene = bindConversation(driver, new ConversationSceneDefinition({ files: Boolean(options.files) }), { ...environment, files: options.files }, interactions);
  const submission = new ConversationSubmission('streaming-submission', 'conversation');
  const frames = [];
  const detach = submission.connectFrames((frame) => {
    frames.push(frame);
  });
  const completed = new Promise((resolve) => {
    const close = submission.connect((snapshot) => {
      if (snapshot.result) {
        close();
        resolve(snapshot);
      }
    });
  });
  t.after(async () => {
    options.release?.();
    if (driver.isRunning(scene)) submission.requestCancellation();
    await interactions.settled();
    detach();
    interactions.close();
  });
  return {
    ...environment,
    submission,
    frames,
    completed,
    calls,
    interactions,
    driver,
    scene,
    start(value = input) {
      submission.start((signal) => driver.run(scene, value, { settings, signal, answerProgress: submission.answerProgress, progress: submission.progress, fileProgress: submission.fileProgress }));
    },
    async milestone(promise) {
      await Promise.race([promise, completed.then((snapshot) => assert.fail(`Submission ended before expected progress: ${JSON.stringify(snapshot.result)}`))]);
    },
  };
}

test('real declared output chain publishes preview before Transcript append and commits the same source once', async (t) => {
  const started = deferred();
  const release = deferred();
  const answer = { kind: 'answer', content: '流式正文😀\n第二行' };
  const raw = JSON.stringify(answer);
  const split = raw.indexOf('😀');
  const f = fixture(
    t,
    async ({ progress }) => {
      progress.publish({ text: raw.slice(0, split) });
      started.resolve();
      await release.promise;
      for (const char of raw.slice(split)) progress.publish({ text: char });
      return envelope(answer);
    },
    { release: release.resolve },
  );
  f.start();
  await f.milestone(started.promise);
  assert.equal(f.transcript.length, 1);
  assert.equal(f.submission.snapshot.answer, undefined);
  assert.equal(f.submission.baseline.preview.state, 'streaming');
  assert.equal(f.submission.baseline.preview.text, '流式正文');
  release.resolve();
  assert.equal((await f.completed).result.status, 'completed');
  assert.equal(f.transcript.length, 2);
  assert.equal(f.transcript.get(1).content, answer.content);
  assert.deepEqual(f.submission.baseline.preview.message, { transcriptId: f.transcript.id, index: 1 });
  assert.equal(f.submission.baseline.preview.state, 'committed');
  assert.equal(f.submission.baseline.preview.consistency, 'complete');
  assert.equal(f.submission.answerProgress.failure, undefined);
  assert.equal(f.calls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(f.frames.filter((frame) => frame.type === 'answer' && frame.change.kind === 'committed').length, 1);
});

test('accepted regeneration starts a clean preview generation rather than appending to the rejected candidate', async (t) => {
  const secondStarted = deferred();
  const release = deferred();
  const answer = { kind: 'answer', content: '第二次正确回答' };
  const f = fixture(
    t,
    async ({ progress, attempt }) => {
      if (attempt === 1) {
        const rejected = { kind: 'wrong-kind', content: '第一次候选' };
        progress.publish({ text: JSON.stringify(rejected) });
        return envelope(rejected);
      }
      progress.publish({ text: '{"kind":"answer","content":"第二次' });
      secondStarted.resolve();
      await release.promise;
      progress.publish({ text: '正确回答"}' });
      return envelope(answer);
    },
    { release: release.resolve },
  );
  f.start();
  await f.milestone(secondStarted.promise);
  assert.equal(f.submission.baseline.preview.generation, 2);
  assert.equal(f.submission.baseline.preview.text, '第二次');
  assert.equal(f.transcript.length, 1);
  release.resolve();
  assert.equal((await f.completed).result.status, 'completed');
  assert.equal(f.submission.baseline.preview.text, answer.content);
  assert.equal(f.submission.baseline.preview.consistency, 'complete');
  const changes = f.frames.filter((frame) => frame.type === 'answer').map((frame) => frame.change);
  assert.equal(changes.filter((change) => change.kind === 'started').length, 2);
  assert.ok(changes.some((change) => change.generation === 1 && change.kind === 'discarded' && change.reason === 'rejected'));
  assert.equal(f.calls.filter((call) => call.purpose === 'answer').length, 2);
});

test('cancellation discards partial preview without appending or saving a partial assistant message', async (t) => {
  const started = deferred();
  const release = deferred();
  let externalSignal;
  const f = fixture(
    t,
    async ({ signal, progress }) => {
      externalSignal = signal;
      progress.publish({ text: '{"kind":"answer","content":"尚未完成' });
      started.resolve();
      await release.promise;
      progress.publish({ text: '的回答"}' });
      return envelope({ kind: 'answer', content: '尚未完成的回答' });
    },
    { release: release.resolve },
  );
  f.start();
  await f.milestone(started.promise);
  assert.equal(f.submission.baseline.preview.text, '尚未完成');
  f.submission.requestCancellation();
  assert.equal((await f.completed).result.status, 'cancelled');
  assert.equal(f.submission.baseline.preview.state, 'discarded');
  assert.equal(f.submission.baseline.preview.reason, 'cancelled');
  assert.equal(f.submission.snapshot.answer, undefined);
  assert.equal(f.transcript.length, 1);
  assert.equal(externalSignal.aborted, false);
  assert.equal(f.interactions.active, true);
  release.resolve();
  await f.interactions.settled();
  assert.equal(f.interactions.states().find((state) => state.request.purpose === 'answer').feedback.payload.content, JSON.stringify({ kind: 'answer', content: '尚未完成的回答' }));
  assert.equal(f.submission.baseline.preview.state, 'discarded');
  assert.equal(f.transcript.length, 1);
});

test('memory post-processing failure preserves the already committed streamed answer', async (t) => {
  const answer = { kind: 'answer', content: '已正式接纳' };
  const f = fixture(
    t,
    async ({ progress }) => {
      for (const char of JSON.stringify(answer)) progress.publish({ text: char });
      return envelope(answer);
    },
    { memoryFailure: true },
  );
  f.start();
  assert.equal((await f.completed).result.status, 'failed');
  assert.equal(f.transcript.length, 2);
  assert.equal(f.transcript.get(1).content, answer.content);
  assert.equal(f.submission.baseline.preview.state, 'committed');
  assert.equal(f.submission.baseline.preview.consistency, 'complete');
  assert.equal(f.submission.snapshot.answer.index, 1);
});

test('a preview mismatch is explicit and never invalidates the independently accepted final answer', async (t) => {
  const answer = { kind: 'answer', content: '最终结果' };
  const f = fixture(t, async ({ progress }) => {
    progress.publish({ text: '{"kind":"answer","content":"不同候选"}' });
    return envelope(answer);
  });
  f.start();
  assert.equal((await f.completed).result.status, 'completed');
  assert.equal(f.transcript.get(1).content, answer.content);
  assert.equal(f.submission.baseline.preview.state, 'committed');
  assert.equal(f.submission.baseline.preview.consistency, 'mismatch');
  assert.equal(f.submission.baseline.preview.text, '不同候选');
  assert.equal(f.calls.filter((call) => call.purpose === 'answer').length, 1);
});

test('document child output reaches the same preview and saves only the accepted complete body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capix-stream-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), '待总结的文档');
  const answer = { kind: 'answer', content: '文档总结全文' };
  const f = fixture(
    t,
    async ({ progress }) => {
      for (const char of JSON.stringify(answer)) progress.publish({ text: char });
      return envelope(answer);
    },
    { files: new WorkspaceFiles({ root }) },
  );
  f.start({ ...input, fileTask: { sourcePath: 'source.txt', output: { path: 'summary.txt' } } });
  assert.equal((await f.completed).result.status, 'completed');
  assert.equal(f.submission.baseline.preview.text, answer.content);
  assert.equal(f.submission.baseline.preview.consistency, 'complete');
  assert.equal(await readFile(join(root, 'summary.txt'), 'utf8'), answer.content);
  assert.equal(f.transcript.get(1).content, answer.content);
  assert.equal(f.submission.snapshot.fileOutput.status, 'created');
});
