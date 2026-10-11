import test from 'node:test';
import assert from 'node:assert/strict';
import { client, transport, deferred, submissionSnapshot } from './fixtures.mjs';

const input = (content = 'question') => ({ messages: [{ role: 'user', content }], contextBudget: 1024 });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const range = { transcriptId: 'fixture-transcript', start: 0, end: 1 };

async function fixture(t, options = {}) {
  const posts = [];
  const entries = new Map();
  let cancels = 0;
  const io = transport({
    submit: async (request, receive, signal) => {
      posts.push(request);
      const entry = { snapshot: submissionSnapshot(request.submissionId), receive, signal };
      entries.set(request.submissionId, entry);
      options.onSubmit?.(entry, request);
      await wait(signal);
    },
    cancel: async (id) => {
      cancels++;
      if (options.cancel) return options.cancel(id, entries);
      return update(id, { cancelRequested: true }, false);
    },
    read: async (id) => entries.get(id).snapshot,
    follow: async (id, receive, signal) => {
      const entry = entries.get(id);
      entry.receive = receive;
      entry.signal = signal;
      receive(entry.snapshot);
      await wait(signal);
    },
  });
  function update(id, change, deliver = true) {
    const entry = entries.get(id);
    entry.snapshot = { ...entry.snapshot, ...change, revision: entry.snapshot.revision + 1 };
    if (deliver) entry.receive(entry.snapshot);
    return entry.snapshot;
  }
  const runtime = client({ conversation: io, queue: options.queue });
  await runtime.initialize();
  t.after(() => {
    runtime.pauseQueue();
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
  });
  return {
    runtime,
    posts,
    entries,
    update,
    get cancels() {
      return cancels;
    },
  };
}

test('FIFO local acceptance fixes input, never writes transcript, and advances on results before entity content catches up', async (t) => {
  const f = await fixture(t);
  const mutable = input('first');
  const first = f.runtime.enqueue(mutable);
  mutable.messages[0].content = 'edited later';
  mutable.contextBudget = 4096;
  const second = f.runtime.enqueue(input('second'));
  assert.equal(f.runtime.getSnapshot().queue.waiting.length, 2);
  assert.equal(f.runtime.getSnapshot().messages.length, 0);
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].submissionId, first.id);
  assert.equal(f.posts[0].input.messages[0].content, 'first');
  assert.equal(f.posts[0].input.contextBudget, 1024);
  assert.ok(Object.isFrozen(f.posts[0].input.messages));
  f.update(first.id, { input: range, answer: { transcriptId: range.transcriptId, index: 1 } });
  await settle();
  assert.equal(f.posts.length, 1, 'answer does not release the running command');
  f.update(first.id, { result: { status: 'completed' } });
  await settle();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].submissionId, second.id);
  assert.equal(f.runtime.getSnapshot().messages.length, 0);
});

test('waiting cancellation and capacity rejection are local and never silently drop input', async (t) => {
  const f = await fixture(t, { queue: { maxWaiting: 2, maxBytes: 1000 } });
  f.runtime.pauseQueue();
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  assert.throws(() => f.runtime.enqueue(input('c')), /队列已满/);
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.cancels, 0);
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [b.id],
  );
  f.runtime.resumeQueue();
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].submissionId, b.id);
  assert.throws(() => f.runtime.enqueue(input('字'.repeat(1000))), /总容量/);
});

test('active cancellation pauses before control delivery, retains input and waits for a real terminal result', async (t) => {
  const f = await fixture(t);
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(a.id, { input: range, answer: { transcriptId: range.transcriptId, index: 1 } });
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.cancels, 1);
  assert.equal(f.runtime.getSnapshot().queue.paused, true);
  assert.equal(f.runtime.getSnapshot().busy, true);
  assert.equal(f.runtime.getSnapshot().submission.remote.cancelRequested, true);
  assert.equal(f.entries.get(a.id).signal.aborted, false, 'cancel does not abort feedback');
  f.runtime.resumeQueue();
  await settle();
  assert.equal(f.posts.length, 1, 'resume cannot bypass unfinished cancellation');
  f.update(a.id, { result: { status: 'cancelled' } });
  await settle();
  assert.equal(f.runtime.getSnapshot().queue.paused, true);
  assert.equal(f.runtime.getSnapshot().submission.remote.answer.index, 1);
  assert.equal(f.posts.length, 1);
  f.runtime.resumeQueue();
  await settle();
  assert.equal(f.posts[1].submissionId, b.id);
});

test('normal completion can win cancellation without automatically sending the next input', async (t) => {
  const gate = deferred();
  const f = await fixture(t, {
    cancel: async (id, entries) => {
      await gate.promise;
      return entries.get(id).snapshot;
    },
  });
  const a = f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  const cancellation = f.runtime.cancelSubmission(a.id);
  await Promise.resolve();
  f.update(a.id, { result: { status: 'completed' } });
  gate.resolve();
  await cancellation;
  await settle();
  assert.equal(f.runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(f.runtime.getSnapshot().queue.paused, true);
  assert.equal(f.posts.length, 1);
});

test('cancel racing registration stays uncertain then retries control on new evidence, never the run POST', async (t) => {
  let registered = false;
  const f = await fixture(t, {
    cancel: async (id, entries) => {
      if (!registered) throw new Error('SUBMISSION_UNAVAILABLE');
      const entry = entries.get(id);
      entry.snapshot = { ...entry.snapshot, revision: entry.snapshot.revision + 1, cancelRequested: true };
      return entry.snapshot;
    },
  });
  const a = f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'uncertain');
  assert.equal(f.runtime.getSnapshot().busy, true);
  registered = true;
  f.update(a.id, { input: range });
  await settle();
  assert.equal(f.cancels, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'acknowledged');
});

test('lost cancel acknowledgement and stopped feedback preserve independent state; query can confirm final outcome', async (t) => {
  const f = await fixture(t, {
    cancel: async (id, entries) => {
      const entry = entries.get(id);
      entry.snapshot = { ...entry.snapshot, revision: 2, cancelRequested: true };
      throw new Error('response lost');
    },
  });
  const a = f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  f.runtime.stopFollowing();
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.runtime.getSnapshot().submission.feedback.status, 'ended');
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'uncertain');
  f.update(a.id, { result: { status: 'cancelled' } }, false);
  await f.runtime.refreshSubmission();
  await settle();
  assert.equal(f.runtime.getSnapshot().submission.remote.result.status, 'cancelled');
  assert.equal(f.runtime.getSnapshot().submission.feedback.status, 'ended');
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().busy, false);
});

test('unknown result cannot be released or bypassed by resume, and cancelAll atomically clears waiting work', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('second'));
  f.runtime.enqueue(input('third'));
  await settle();
  f.runtime.stopFollowing();
  assert.throws(() => f.runtime.releaseSubmission(), /尚未确认结束/);
  f.runtime.resumeQueue();
  await settle();
  assert.equal(f.posts.length, 1);
  await f.runtime.cancelAll();
  assert.equal(f.runtime.getSnapshot().queue.waiting.length, 0);
  assert.equal(f.runtime.getSnapshot().queue.paused, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.cancels, 1);
});

for (const status of ['failed', 'rejected']) {
  test(`${status} pauses the queue instead of draining dependent inputs`, async (t) => {
    const f = await fixture(t);
    const a = f.runtime.enqueue(input());
    f.runtime.enqueue(input('later'));
    await settle();
    f.update(a.id, { result: { status, error: { code: status === 'rejected' ? 'RUNTIME_BUSY' : 'BROKEN', message: 'test' } } });
    await settle();
    assert.equal(f.posts.length, 1);
    assert.equal(f.runtime.getSnapshot().queue.paused, true);
    assert.equal(f.runtime.getSnapshot().busy, false);
  });
}

test('incomplete progress without result cannot advance; a later completed result still leaves the queue paused', async (t) => {
  const f = await fixture(t);
  const a = f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  f.update(a.id, { integrity: { status: 'incomplete', error: { code: 'GAP', message: 'unknown progress' } } });
  await settle();
  assert.equal(f.posts.length, 1);
  f.update(a.id, { result: { status: 'completed' } });
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().queue.paused, true);
});

test('a subscriber can pause before an immediate POST and resume the same identity exactly once', async (t) => {
  const f = await fixture(t);
  let paused = false;
  const unsubscribe = f.runtime.subscribe(() => {
    if (!paused && f.runtime.getSnapshot().submission) {
      paused = true;
      f.runtime.pauseQueue();
    }
  });
  await f.runtime.submit(input());
  const id = f.runtime.getSnapshot().submission.id;
  await settle();
  assert.equal(f.posts.length, 0);
  unsubscribe();
  f.runtime.resumeQueue();
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].submissionId, id);
});

test('a subscriber pausing on terminal publication beats an already scheduled advance', async (t) => {
  const f = await fixture(t);
  const a = f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  const unsubscribe = f.runtime.subscribe(() => {
    if (f.runtime.getSnapshot().submission.remote?.result) f.runtime.pauseQueue();
  });
  f.update(a.id, { result: { status: 'completed' } });
  await settle();
  unsubscribe();
  assert.equal(f.posts.length, 1);
});

test('cancel and query facts share identity, transcript and monotonicity checks without changing feedback status', async (t) => {
  const f = await fixture(t, { cancel: async (id) => submissionSnapshot(id, { revision: 10, cancelRequested: true, input: { ...range, transcriptId: 'foreign' } }) });
  const a = f.runtime.enqueue(input());
  await settle();
  f.update(a.id, { input: range });
  f.runtime.stopFollowing();
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.runtime.getSnapshot().submission.remote.input.transcriptId, range.transcriptId);
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'uncertain');
  assert.equal(f.runtime.getSnapshot().submission.feedback.status, 'ended');
});
