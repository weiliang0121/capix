import test from 'node:test';
import assert from 'node:assert/strict';
import { client, transport, deferred, submissionSnapshot } from './fixtures.mjs';

const input = (content = 'question') => ({ messages: [{ role: 'user', content }], contextBudget: 1024 });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const range = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const ready = { conversationId: 'fixture-conversation', transcriptId: range.transcriptId, status: 'ready' };
const busy = { conversationId: 'fixture-conversation', transcriptId: range.transcriptId, status: 'busy' };
const failure = { code: 'BROKEN', message: 'test failure' };
const rejected = { status: 'rejected', error: { code: 'RUNTIME_BUSY', message: 'busy' }, retry: 'admission' };

async function fixture(t, options = {}) {
  const posts = [];
  const entries = new Map();
  const reads = [];
  let cancels = 0;
  let admissions = 0;
  const io = transport({
    admission: async (_conversationId, signal) => {
      admissions++;
      return options.admission ? options.admission(signal) : ready;
    },
    submit: async (request, receive, signal) => {
      posts.push(request);
      const entry = { snapshot: submissionSnapshot(request.submissionId), receive, signal };
      entries.set(request.submissionId, entry);
      options.onSubmit?.(entry, request);
      if (options.disconnect) throw new Error('connection lost');
      await wait(signal);
    },
    cancel: async (id) => {
      cancels++;
      if (options.cancel) return options.cancel(id, entries);
      return update(id, { cancelRequested: true }, false);
    },
    read: async (id, signal) => {
      reads.push(id);
      return options.read ? options.read(id, entries, signal) : entries.get(id).snapshot;
    },
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
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
  });
  return {
    runtime,
    posts,
    entries,
    reads,
    update,
    id: (index = 0) => posts[index].submissionId,
    get cancels() {
      return cancels;
    },
    get admissions() {
      return admissions;
    },
  };
}

async function tick(t, delay) {
  t.mock.timers.tick(delay);
  await settle();
}

test('FIFO fixes local input and advances on known results without waiting for entity content', async (t) => {
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
  assert.notEqual(f.id(), first.id, 'local input and POST have different lifetimes');
  assert.equal(f.runtime.getSnapshot().submission.queueId, first.id);
  assert.equal(f.posts[0].input.messages[0].content, 'first');
  assert.equal(f.posts[0].input.contextBudget, 1024);
  assert.ok(Object.isFrozen(f.posts[0].input.messages));
  assert.equal(f.admissions, 0, 'the first POST is itself final admission');
  f.update(f.id(), { input: range, answer: { transcriptId: range.transcriptId, index: 1 } });
  await settle();
  assert.equal(f.posts.length, 1, 'answer does not release running work');
  f.update(f.id(), { result: { status: 'completed' }, admission: ready });
  await settle();
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, second.id);
  assert.equal(f.runtime.getSnapshot().messages.length, 0);
  assert.equal(f.admissions, 0, 'a ready terminal hint avoids a separate preflight');
});

test('waiting withdrawal and bounded local acceptance never silently drop other input', async (t) => {
  const f = await fixture(t, { queue: { maxWaiting: 2, maxBytes: 1000 } });
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  assert.throws(() => f.runtime.enqueue(input('c')), /队列已满/);
  const withdrawn = f.runtime.cancelSubmission(a.id);
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [b.id],
  );
  await withdrawn;
  await settle();
  assert.equal(f.cancels, 0);
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
  assert.throws(() => f.runtime.enqueue(input('字'.repeat(1000))), /总容量/);
});

test('active cancellation waits for a real result and automatically advances afterward', async (t) => {
  const f = await fixture(t);
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { input: range, answer: { transcriptId: range.transcriptId, index: 1 } });
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.cancels, 1);
  assert.equal(f.runtime.getSnapshot().busy, true);
  assert.equal(f.runtime.getSnapshot().submission.remote.cancelRequested, true);
  assert.equal(f.entries.get(f.id()).signal.aborted, false, 'cancel does not abort feedback');
  await settle();
  assert.equal(f.posts.length, 1);
  f.update(f.id(), { result: { status: 'cancelled' }, admission: ready });
  await settle();
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
  assert.equal(f.runtime.getSnapshot().submissions.get(f.id()).remote.answer.index, 1);
});

test('normal completion winning cancellation still permits the next input; late control response cannot replace it', async (t) => {
  const gate = deferred();
  const f = await fixture(t, {
    cancel: async (id, entries) => {
      await gate.promise;
      return entries.get(id).snapshot;
    },
  });
  const a = f.runtime.enqueue(input());
  const b = f.runtime.enqueue(input('later'));
  await settle();
  const cancellation = f.runtime.cancelSubmission(a.id);
  await Promise.resolve();
  f.update(f.id(), { result: { status: 'completed' }, admission: ready });
  await settle();
  gate.resolve();
  await cancellation;
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
});

test('cancel racing registration retries control on new evidence, never the run POST', async (t) => {
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
  registered = true;
  f.update(f.id(), { input: range });
  await settle();
  assert.equal(f.cancels, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'acknowledged');
});

test('a lost cancellation response is resolved by real query facts before automatically advancing', async (t) => {
  const f = await fixture(t, {
    cancel: async (id, entries) => {
      const entry = entries.get(id);
      entry.snapshot = { ...entry.snapshot, revision: 2, cancelRequested: true };
      throw new Error('response lost');
    },
  });
  const a = f.runtime.enqueue(input());
  const b = f.runtime.enqueue(input('later'));
  await settle();
  f.runtime.stopFollowing();
  await f.runtime.cancelSubmission(a.id);
  assert.equal(f.runtime.getSnapshot().submission.cancellation.status, 'uncertain');
  f.update(f.id(), { result: { status: 'cancelled' }, admission: ready }, false);
  await f.runtime.refreshSubmission();
  await settle();
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
});

for (const status of ['failed', 'rejected']) {
  test(`${status} is a known outcome; query admission instead of blocking later inputs`, async (t) => {
    const f = await fixture(t);
    f.runtime.enqueue(input());
    const b = f.runtime.enqueue(input('later'));
    await settle();
    f.update(f.id(), { result: { status, error: failure } });
    await settle();
    assert.equal(f.admissions, 1);
    assert.equal(f.posts.length, 2);
    assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
  });
}

test('incomplete progress is not a terminal result, but does not veto a later confirmed result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  f.update(f.id(), { integrity: { status: 'incomplete', error: { code: 'GAP', message: 'unknown progress' } } });
  await settle();
  assert.equal(f.posts.length, 1);
  await tick(t, 250);
  assert.equal(f.reads.length, 1);
  await tick(t, 499);
  assert.equal(f.reads.length, 1, 'unchanged incomplete facts do not create a busy loop');
  f.update(f.id(), { result: { status: 'completed' }, admission: ready });
  await settle();
  assert.equal(f.posts.length, 2);
});

test('unknown feedback automatically queries the same ID even without waiting work; stopFollowing stops recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { disconnect: true });
  f.runtime.enqueue(input());
  await settle();
  assert.throws(() => f.runtime.releaseSubmission(), /尚未确认结束/);
  await tick(t, 250);
  assert.deepEqual(f.reads, [f.id()]);
  assert.equal(f.admissions, 0, 'availability is not evidence of an old submission result');
  f.runtime.stopFollowing();
  await tick(t, 20_000);
  assert.deepEqual(f.reads, [f.id()]);
  assert.equal(f.posts.length, 1);
});

test('automatic result recovery releases only the original confirmed attempt and then sends the next item', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { disconnect: true });
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { result: { status: 'failed', error: failure }, admission: ready }, false);
  await tick(t, 250);
  assert.deepEqual(f.reads, [f.id()]);
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
  assert.equal(f.runtime.getSnapshot().submissions.get(f.id()).queueId, a.id);
});

test('busy rejection retains local FIFO identity and retries admission using a new POST ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let available = false;
  const f = await fixture(t, { admission: async () => (available ? ready : busy) });
  const a = f.runtime.enqueue(input('a'));
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { result: rejected, admission: busy });
  await settle();
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [a.id, b.id],
  );
  await tick(t, 250);
  assert.equal(f.posts.length, 1);
  assert.match(f.runtime.getSnapshot().queue.blocked, /服务正在处理/);
  available = true;
  await tick(t, 500);
  assert.equal(f.posts.length, 2);
  assert.notEqual(f.id(0), f.id(1));
  assert.equal(f.runtime.getSnapshot().submission.queueId, a.id);
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [b.id],
  );
  f.update(f.id(1), { result: { status: 'completed' }, admission: ready });
  await settle();
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
  assert.deepEqual(
    f.posts.map((post) => post.input.messages[0].content),
    ['a', 'a', 'b'],
  );
});

test('ready query does not reserve admission; a new busy rejection retains the same item again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const a = f.runtime.enqueue(input('a'));
  f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { result: rejected, admission: busy });
  await tick(t, 250);
  f.update(f.id(1), { result: rejected, admission: busy });
  await tick(t, 500);
  assert.equal(f.posts.length, 3);
  assert.equal(f.runtime.getSnapshot().submission.queueId, a.id);
  assert.equal(new Set(f.posts.map((post) => post.submissionId)).size, 3);
  assert.deepEqual(
    f.posts.map((post) => post.input.messages[0].content),
    ['a', 'a', 'a'],
  );
});

test('withdrawing a busy head aborts its probe; late availability cannot resurrect the removed input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let signal;
  const f = await fixture(t, {
    admission: async (value) => {
      signal = value;
      return gate.promise;
    },
  });
  const a = f.runtime.enqueue(input());
  await settle();
  f.update(f.id(), { result: rejected, admission: busy });
  await tick(t, 250);
  await f.runtime.cancelSubmission(a.id);
  assert.equal(signal.aborted, true);
  assert.equal(f.runtime.getSnapshot().submission, undefined);
  gate.resolve(ready);
  await settle();
  await tick(t, 20_000);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.runtime.getSnapshot().queue.waiting, []);
});

test('unavailable service preserves inputs and automatically resumes after service confirmation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let available = false;
  const f = await fixture(t, { admission: async () => (available ? ready : { ...ready, status: 'unavailable', error: failure }) });
  f.runtime.enqueue(input());
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { result: { status: 'failed', error: failure } });
  await settle();
  assert.equal(f.posts.length, 1);
  assert.match(f.runtime.getSnapshot().queue.blocked, /服务暂不可用/);
  available = true;
  await tick(t, 250);
  assert.equal(f.posts.length, 2);
  assert.equal(f.runtime.getSnapshot().submission.queueId, b.id);
});

test('changed transcript identity blocks admission permanently until old waiting input is withdrawn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { admission: async () => ({ ...ready, transcriptId: 'different' }) });
  f.runtime.enqueue(input());
  const b = f.runtime.enqueue(input('b'));
  await settle();
  f.update(f.id(), { result: { status: 'completed' } });
  await settle();
  await tick(t, 30_000);
  assert.equal(f.admissions, 1);
  assert.equal(f.posts.length, 1);
  assert.match(f.runtime.getSnapshot().queue.blocked, /消息集合已改变/);
  assert.deepEqual(
    f.runtime.getSnapshot().queue.waiting.map((item) => item.id),
    [b.id],
  );
});

test('a subscriber may withdraw before immediate POST; reentrancy cannot send the removed attempt', async (t) => {
  const f = await fixture(t);
  const unsubscribe = f.runtime.subscribe(() => {
    const current = f.runtime.getSnapshot().submission;
    if (current) void f.runtime.cancelSubmission(current.queueId);
  });
  await f.runtime.submit(input());
  await settle();
  unsubscribe();
  assert.equal(f.posts.length, 0);
});

test('clearing waiting work on terminal publication beats an already scheduled advance', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  const unsubscribe = f.runtime.subscribe(() => {
    if (f.runtime.getSnapshot().submission.remote?.result) f.runtime.clearQueue();
  });
  f.update(f.id(), { result: { status: 'completed' }, admission: ready });
  await settle();
  unsubscribe();
  assert.equal(f.posts.length, 1);
});

test('cancelAll clears waiting items without falsely releasing an unknown active attempt', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('second'));
  await settle();
  await f.runtime.cancelAll();
  assert.equal(f.runtime.getSnapshot().queue.waiting.length, 0);
  assert.equal(f.runtime.getSnapshot().busy, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.cancels, 1);
});

test('invalid custom admission responses never authorize sending and use bounded confirmation retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let response = { ...ready, status: 'something-else' };
  const f = await fixture(t, { admission: async () => response });
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  f.update(f.id(), { result: { status: 'completed' } });
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.admissions, 1);
  response = { ...ready, status: 'unavailable', error: {} };
  await tick(t, 250);
  assert.equal(f.posts.length, 1);
  assert.equal(f.admissions, 2);
  response = ready;
  await tick(t, 500);
  assert.equal(f.posts.length, 2);
});

test('incomplete or already accepted facts cannot grant admission retry permission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  assert.throws(() => f.update(f.id(), { result: rejected, integrity: { status: 'incomplete', error: failure } }), /明确未受理/);
  assert.equal(f.runtime.getSnapshot().submission.remote, undefined);
  assert.equal(f.posts.length, 1);
  assert.equal(f.admissions, 0);
});

test('stopping automatic recovery discards a late result query even if transport ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let signal;
  const f = await fixture(t, {
    disconnect: true,
    read: async (_id, _entries, requestSignal) => {
      signal = requestSignal;
      return gate.promise;
    },
  });
  f.runtime.enqueue(input());
  f.runtime.enqueue(input('later'));
  await settle();
  await tick(t, 250);
  f.runtime.stopFollowing();
  assert.equal(signal.aborted, true);
  gate.resolve(submissionSnapshot(f.id(), { revision: 1, result: { status: 'completed' }, admission: ready }));
  await settle();
  assert.equal(f.runtime.getSnapshot().submission.remote, undefined);
  assert.equal(f.posts.length, 1);
  assert.equal(f.runtime.getSnapshot().busy, true);
});

test('an immediate submission retains its acceptance notification across a rejected admission attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const accepted = [];
  const sending = f.runtime.submit(input(), (submission) => {
    accepted.push(submission);
  });
  await settle();
  const localId = f.runtime.getSnapshot().submission.queueId;
  f.update(f.id(), { result: rejected, admission: busy });
  await tick(t, 250);
  await sending;
  assert.equal(accepted.length, 0);
  f.update(f.id(1), { input: range });
  await settle();
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, f.id(1));
  assert.equal(accepted[0].queueId, localId);
});
