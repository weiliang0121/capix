import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime, TranscriptSequenceError } from '@capix/client-runtime';
import { deferred, submissionDelivery, transcriptSnapshot } from './fixtures.mjs';

const question = { role: 'user', content: '问题' };
const answer = { role: 'assistant', content: '回答' };
const input = { messages: [question] };
const range = { transcriptId: 'publication-transcript', start: 0, end: 1 };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const appended = (revision, start, messages) => ({ type: 'delta', event: { type: 'transcript', transcriptId: range.transcriptId, revision, occurredAt: '2026-10-11T00:00:00Z', change: { kind: 'messages-appended', start, messages } } });

async function fixture(t, options = {}) {
  const feedback = deferred();
  const ready = deferred();
  let delivery;
  let emit;
  let failTranscript;
  let posts = 0;
  const runtime = new ClientRuntime({
    conversation: {
      config: async () => ({ configured: true, model: 'fixture', contextBudget: 1000, maxOutputTokens: 100, timeoutMs: 1000 }),
      submit: async (request, receive, signal) => {
        posts++;
        delivery = submissionDelivery(request, receive);
        options.onSubmit?.(delivery);
        ready.resolve();
        await Promise.race([feedback.promise, wait(signal)]);
      },
    },
    transcripts: {
      transcript: async () => assert.fail('a healthy synchronized entity needs no query'),
      observeTranscript:
        options.observeTranscript ??
        (async (_id, receive, signal) => {
          emit = receive;
          receive({ type: 'baseline', snapshot: transcriptSnapshot(options.messages ?? [], range.transcriptId, 0) });
          await new Promise((resolve, reject) => {
            failTranscript = reject;
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
          });
        }),
    },
  });
  t.after(() => {
    runtime.releaseSubmission();
    runtime.stopTranscript();
    feedback.resolve();
  });
  await runtime.initialize();
  await settle();
  return {
    runtime,
    ready: ready.promise,
    get delivery() {
      return delivery;
    },
    get posts() {
      return posts;
    },
    emit: (frame) => emit(frame),
    failTranscript: (error) => failTranscript(error),
    finish: async (work) => {
      feedback.resolve();
      await work;
      await settle();
    },
  };
}

test('same-turn facts and entity deltas publish one coordinated snapshot without exposing partial ingress', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await f.ready;
  await settle();
  const before = f.runtime.getSnapshot();
  const published = [];
  f.runtime.subscribe(() => published.push(f.runtime.getSnapshot()));

  f.delivery.input(range);
  f.emit(appended(1, 0, [question]));
  f.delivery.answer();
  f.emit(appended(2, 1, [answer]));
  f.delivery.complete();

  assert.equal(f.runtime.getSnapshot(), before, 'public state remains stable throughout synchronous ingress');
  assert.equal(published.length, 0, 'receiving data does not directly notify bindings');
  await Promise.resolve();

  assert.equal(published.length, 1);
  const current = published[0];
  assert.equal(current, f.runtime.getSnapshot());
  assert.equal(current.inputAvailability, 'available');
  assert.equal(current.answerAvailability, 'available');
  assert.equal(current.submission.remote.result.status, 'completed');
  assert.equal(current.transcripts.get(range.transcriptId).snapshot.revision, 2, 'each entity delta is consumed even when notifications coalesce');
  assert.deepEqual(current.messages, [question, answer]);
  assert.equal(before.messages.length, 0);
  assert.equal(before.transcripts.get(range.transcriptId).snapshot.revision, 0);
  assert.equal(before.submission.remote, undefined);
  await f.finish(work);
});

test('a completed submission can publish pending content, then become available through entity synchronization alone', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await f.ready;
  f.delivery.input(range);
  f.delivery.answer();
  f.delivery.complete();
  await f.finish(work);

  const completed = f.runtime.getSnapshot();
  assert.equal(completed.busy, false);
  assert.equal(completed.inputAvailability, 'pending');
  assert.equal(completed.answerAvailability, 'pending');
  assert.equal(completed.messages.length, 0);
  assert.equal(completed.submission.remote.result.status, 'completed');
  assert.equal(completed.observation.enabled, false);

  f.emit(appended(1, 0, [question, answer]));
  assert.equal(f.runtime.getSnapshot(), completed);
  await Promise.resolve();
  const available = f.runtime.getSnapshot();
  assert.equal(available.inputAvailability, 'available');
  assert.equal(available.answerAvailability, 'available');
  assert.deepEqual(available.messages, [question, answer]);
  assert.equal(available.submission.remote, completed.submission.remote);
  assert.equal(f.posts, 1, 'content catch-up does not retry a submission');
});

test('entity content arriving first does not invent a submission answer before its formal locator', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await f.ready;
  f.emit(appended(1, 0, [question, answer]));
  f.delivery.input(range);
  await Promise.resolve();

  const content = f.runtime.getSnapshot();
  assert.deepEqual(content.messages, [question, answer]);
  assert.equal(content.inputAvailability, 'available');
  assert.equal(content.answerAvailability, 'unconfirmed');
  assert.equal(content.answered, false);

  f.delivery.answer();
  await Promise.resolve();
  const confirmed = f.runtime.getSnapshot();
  assert.equal(confirmed.answerAvailability, 'available');
  assert.equal(confirmed.answered, true);
  assert.equal(confirmed.messages, content.messages, 'locator acceptance does not rebuild or duplicate entity content');
  f.delivery.complete();
  await f.finish(work);
});

test('failed postprocessing and later entity connection failure retain an already available answer', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await f.ready;
  f.delivery.input(range);
  f.delivery.answer();
  f.emit(appended(1, 0, [question, answer]));
  f.delivery.fail('POSTPROCESS', '后处理失败');
  await f.finish(work);

  const completed = f.runtime.getSnapshot();
  assert.equal(completed.answerAvailability, 'available');
  assert.equal(completed.submission.remote.result.status, 'failed');
  const disconnected = new Error('entity connection failed');
  f.failTranscript(disconnected);
  await settle();

  const stopped = f.runtime.getSnapshot();
  assert.equal(stopped.transcripts.get(range.transcriptId).syncing, false);
  assert.equal(stopped.transcripts.get(range.transcriptId).error, disconnected);
  assert.equal(stopped.answerAvailability, 'available');
  assert.equal(stopped.messages, completed.messages);
  assert.equal(stopped.submission.remote, completed.submission.remote, 'synchronization failure does not rewrite the business outcome');
  assert.equal(completed.transcripts.get(range.transcriptId).error, undefined, 'the prior published snapshot remains fixed');
});

test('unrecoverable entity gaps preserve content availability and the independently confirmed service result', async (t) => {
  const firstGap = deferred();
  const secondGap = deferred();
  let connections = 0;
  const f = await fixture(t, {
    observeTranscript: async (_id, receive) => {
      const connection = ++connections;
      receive({ type: 'baseline', snapshot: transcriptSnapshot([question, answer], range.transcriptId, 1) });
      await (connection === 1 ? firstGap.promise : secondGap.promise);
      receive(appended(3, 2, [{ role: 'user', content: 'missing a preceding revision' }]));
    },
  });
  const work = f.runtime.submit(input);
  await f.ready;
  f.delivery.input(range);
  f.delivery.answer();
  f.delivery.complete();
  await f.finish(work);

  const completed = f.runtime.getSnapshot();
  firstGap.resolve();
  await settle();
  assert.equal(connections, 2);
  secondGap.resolve();
  await settle();

  const failedSync = f.runtime.getSnapshot();
  assert.ok(failedSync.transcripts.get(range.transcriptId).error instanceof TranscriptSequenceError);
  assert.deepEqual(failedSync.messages, [question, answer]);
  assert.equal(failedSync.answerAvailability, 'available');
  assert.equal(failedSync.submission.remote, completed.submission.remote);
  assert.equal(failedSync.submission.remote.result.status, 'completed');
});

test('internal submission ownership blocks a second synchronous POST', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await assert.rejects(f.runtime.submit(input), /尚未确认结束/);
  assert.equal(f.posts, 1);
  await f.ready;
  f.delivery.input(range);
  f.delivery.complete();
  await f.finish(work);
});

test('acceptance notification follows a matching public snapshot and is not lost or repeated by coalescing', async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  const notifications = [];
  f.runtime.subscribe(() => snapshots.push(f.runtime.getSnapshot()));
  const work = f.runtime.submit(input, () => {
    const state = f.runtime.getSnapshot();
    notifications.push(state);
    assert.equal(state.submission.id, f.delivery.snapshot.submissionId);
    assert.deepEqual(state.submission.remote.input, range);
    assert.equal(state.pending, '');
    assert.equal(state.inputAvailability, 'available');
  });
  await f.ready;
  await settle();
  f.delivery.input(range);
  f.emit(appended(1, 0, [question, answer]));
  f.delivery.answer();
  f.delivery.complete();
  assert.equal(notifications.length, 0, 'acceptance does not escape during source consumption');
  await Promise.resolve();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].submission.remote.result.status, 'completed');
  assert.ok(snapshots.includes(notifications[0]), 'subscribers receive the same coherent snapshot as the notification');
  assert.equal(f.runtime.getSnapshot().submission.notificationError, undefined);
  await f.finish(work);
  assert.equal(notifications.length, 1);
});

test('subscriber reentrancy cannot replace the public snapshot midway through a notification batch', async (t) => {
  const f = await fixture(t);
  const work = f.runtime.submit(input);
  await f.ready;
  await settle();
  let acted = false;
  let beforeRelease;
  let afterRelease;
  const seen = [];
  f.runtime.subscribe(() => {
    if (acted) return;
    acted = true;
    beforeRelease = f.runtime.getSnapshot();
    f.runtime.releaseSubmission();
    afterRelease = f.runtime.getSnapshot();
  });
  f.runtime.subscribe(() => seen.push(f.runtime.getSnapshot()));

  f.delivery.input(range);
  await settle();
  assert.equal(beforeRelease, afterRelease);
  assert.equal(seen[0], beforeRelease, 'later listeners still consume the same publication');
  assert.deepEqual(seen[0].submission.remote.input, range);
  assert.equal(seen.at(-1).submission, undefined, 'the reentrant command is published in a subsequent batch');
  assert.notEqual(seen[0], seen.at(-1));
  await f.finish(work);
});

test('acceptance queued by a reentrant submission survives immediate release and carries its original identity', async (t) => {
  const f = await fixture(t, { onSubmit: (delivery) => delivery.input(range) });
  let acted = false;
  let work;
  let beforeSubmit;
  let afterRelease;
  const notifications = [];
  f.runtime.subscribe(() => {
    if (acted) return;
    acted = true;
    beforeSubmit = f.runtime.getSnapshot();
    work = f.runtime.submit(input, (submission) => {
      notifications.push({ submission, published: f.runtime.getSnapshot() });
    });
    f.runtime.releaseSubmission();
    afterRelease = f.runtime.getSnapshot();
  });

  f.emit(appended(1, 0, [question]));
  await settle();
  assert.equal(beforeSubmit, afterRelease, 'commands issued inside a listener leave its public view fixed');
  assert.equal(f.posts, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].submission.id, f.delivery.snapshot.submissionId);
  assert.deepEqual(notifications[0].submission.remote.input, range);
  assert.equal(notifications[0].submission.notificationError, undefined);
  assert.equal(notifications[0].published.submission, undefined, 'the callback identifies an accepted submission even after tracking has been released');
  assert.equal(f.runtime.getSnapshot().submission, undefined);
  await f.finish(work);
  assert.equal(notifications.length, 1);
});

test('published message snapshots do not retain mutable transport message references', async (t) => {
  const first = { role: 'user', content: 'initial' };
  const f = await fixture(t, { messages: [first] });
  const initial = f.runtime.getSnapshot();
  first.content = 'transport rewrote the baseline';
  assert.equal(initial.messages[0].content, 'initial');

  const added = { role: 'assistant', content: 'accepted delta' };
  const frame = appended(1, 1, [added]);
  f.emit(frame);
  added.content = 'transport rewrote the delta';
  frame.event.change.messages.push({ role: 'user', content: 'unaccepted extra item' });
  await Promise.resolve();

  assert.equal(initial.messages.length, 1);
  assert.equal(f.runtime.getSnapshot().messages.length, 2);
  assert.equal(f.runtime.getSnapshot().messages[1].content, 'accepted delta');
});
