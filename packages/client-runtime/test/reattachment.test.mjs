import test from 'node:test';

import assert from 'node:assert/strict';

import { ClientSubmission, SubmissionContractError, SubmissionUnavailableError } from '@capix/client-runtime';

import { ConversationQueue } from '../dist/queue.js';

const identity = { conversationId: 'conversation', submissionId: 'existing-submission' };

const transcriptId = 'transcript';

const range = { transcriptId, start: 0, end: 1 };

const ready = { conversationId: identity.conversationId, transcriptId, status: 'ready' };

const input = { messages: [{ role: 'user', content: 'next' }] };

const baseline = (patch = {}) => ({ type: 'baseline', submission: { ...identity, revision: 1, executions: [], integrity: { status: 'complete' }, input: range, ...patch } });

const settle = () => new Promise((resolve) => setImmediate(resolve));

const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

function fixture(t, overrides = {}, initialized = true) {
  const posts = [];
  const reads = [];
  const follows = [];
  const cancels = [];
  const admissions = [];
  const transport = {
    read: async (id) => {
      reads.push(id);
      return baseline();
    },
    follow: async (id, receive, signal) => {
      follows.push(id);
      receive(baseline());
      await wait(signal);
    },
    cancel: async (id) => {
      cancels.push(id);
      return baseline({ revision: 2, cancelRequested: true });
    },
    admission: async (id) => {
      admissions.push(id);
      return ready;
    },
    submit: async (request, receive) => {
      posts.push(request);
      receive(baseline({ submissionId: request.submissionId, result: { status: 'completed' }, admission: ready }));
    },
    ...overrides,
  };
  const queue = new ConversationQueue(
    transport,
    () => ({ ready: initialized, conversationId: identity.conversationId, transcriptId }),
    () => {},
  );
  t.after(() => queue.stopFollowing());
  return { queue, posts, reads, follows, cancels, admissions };
}

test('reattachment fixes the original identity without a local input, queue entry or POST', async (t) => {
  const f = fixture(t, {}, false);
  const submission = f.queue.attach(identity, transcriptId, baseline());
  assert.equal(submission.id, identity.submissionId);
  assert.equal(submission.input, undefined);
  assert.equal(submission.snapshot.pending, undefined);
  assert.equal(submission.snapshot.queueId, undefined);
  assert.equal(submission.dispatched, true);
  assert.deepEqual(f.queue.snapshot.waiting, []);
  await settle();
  assert.equal(submission.snapshot.feedback.status, 'connecting');
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reads, []);
  await f.queue.refresh();
  const following = f.queue.reconnect();
  await settle();
  assert.deepEqual(f.reads, [identity.submissionId]);
  assert.deepEqual(f.follows, [identity.submissionId]);
  assert.deepEqual(f.posts, []);
  assert.throws(() => submission.send({}, { transcriptId, changed() {} }), /不能重复发送/);
  f.queue.stopFollowing();
  await following;
});

test('reattachment validates submission, conversation and transcript identities before installing tracking', (t) => {
  const f = fixture(t);
  for (const patch of [{ submissionId: 'other' }, { conversationId: 'other' }, { input: { ...range, transcriptId: 'other' } }]) {
    assert.throws(() => f.queue.attach(identity, transcriptId, baseline(patch)), SubmissionContractError);
    assert.equal(f.queue.submission, undefined);
  }
  assert.throws(() => ClientSubmission.attach(identity, '', baseline()), SubmissionContractError);
});

test('an attached terminal rejection never invents a retry input even if admission retry is allowed', async (t) => {
  const f = fixture(t);
  f.queue.attach(identity, transcriptId, baseline({ input: undefined, result: { status: 'rejected', retry: 'admission', error: { code: 'BUSY', message: 'busy' } } }));
  await settle();
  assert.equal(f.queue.submission.snapshot.feedback.status, 'ended');
  assert.equal(f.queue.canSwitchConversation, true);
  assert.deepEqual(f.queue.snapshot.waiting, []);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.admissions, []);
});

test('cancelling an attached submission targets its original ID and waits for its actual result', async (t) => {
  let receive;
  const f = fixture(t, {
    follow: async (_id, accept, signal) => {
      receive = accept;
      await wait(signal);
    },
  });
  f.queue.attach(identity, transcriptId, baseline());
  const following = f.queue.reconnect();
  await f.queue.cancel(identity.submissionId);
  assert.deepEqual(f.cancels, [identity.submissionId]);
  assert.equal(f.queue.submission.snapshot.cancellation.status, 'acknowledged');
  assert.equal(f.queue.canSwitchConversation, false);
  f.queue.enqueue(input);
  await settle();
  assert.deepEqual(f.posts, []);
  receive(baseline({ revision: 3, cancelRequested: true, result: { status: 'cancelled' }, admission: ready }));
  await settle();
  assert.equal(f.posts.length, 1);
  assert.notEqual(f.posts[0].submissionId, identity.submissionId);
  await following;
});

test('unavailable identity remains unknown, stops automatic queries and cannot be bypassed by clearing waiting work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const unavailable = new SubmissionUnavailableError('gone');
  const f = fixture(t, {
    read: async () => {
      reads++;
      throw unavailable;
    },
  });
  f.queue.attach(identity, transcriptId);
  await assert.rejects(f.queue.refresh(), (error) => error === unavailable);
  f.queue.enqueue(input);
  await settle();
  assert.equal(f.queue.submission.snapshot.feedback.status, 'unavailable');
  assert.equal(f.queue.submission.snapshot.remote, undefined);
  assert.equal(f.queue.canSwitchConversation, false);
  assert.throws(() => f.queue.abandon(), /先撤回/);
  f.queue.clear();
  assert.throws(() => f.queue.release(), /尚未确认结束/);
  assert.throws(() => f.queue.prepare(input), /尚未确认结束/);
  f.queue.stopFollowing();
  assert.equal(f.queue.submission.snapshot.feedback.status, 'unavailable');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(reads, 1);
  assert.deepEqual(f.posts, []);
});

test('explicit abandonment makes no cancellation or POST and requires admission before automatically sending new input', async (t) => {
  let authorize;
  const f = fixture(t, {
    read: async () => {
      throw new SubmissionUnavailableError('gone');
    },
    admission: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  f.queue.attach(identity, transcriptId);
  assert.throws(() => f.queue.abandon(), /只有服务明确/);
  await assert.rejects(f.queue.refresh(), SubmissionUnavailableError);
  f.queue.abandon();
  assert.equal(f.queue.submission, undefined);
  assert.deepEqual(f.cancels, []);
  const next = f.queue.enqueue(input);
  await settle();
  assert.deepEqual(f.posts, []);
  assert.equal(f.queue.snapshot.waiting.length, 1);
  authorize(ready);
  await settle();
  assert.equal(f.posts.length, 1);
  assert.equal(f.queue.submission.snapshot.queueId, next.id);
  assert.notEqual(f.posts[0].submissionId, identity.submissionId);
});

test('unavailable follow reports unknown rather than failed or completed', async (t) => {
  const f = fixture(t, {
    follow: async () => {
      throw new SubmissionUnavailableError('expired');
    },
  });
  f.queue.attach(identity, transcriptId, baseline());
  await f.queue.reconnect();
  assert.equal(f.queue.submission.snapshot.feedback.status, 'unavailable');
  assert.equal(f.queue.submission.snapshot.remote.result, undefined);
  assert.equal(f.queue.canSwitchConversation, false);
  assert.deepEqual(f.posts, []);
});

test('interrupted feedback rechecks the same ID then resumes follow instead of repeatedly polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.queue.attach(identity, transcriptId, baseline());
  f.queue.submission.feedback({ status: 'interrupted', error: new Error('network') });
  f.queue.checkEnvironment();
  await settle();
  t.mock.timers.tick(250);
  await settle();
  assert.deepEqual(f.reads, [identity.submissionId]);
  assert.deepEqual(f.follows, [identity.submissionId]);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(f.reads, [identity.submissionId]);
  assert.deepEqual(f.posts, []);
});

test('querying a stopped submission only updates facts and does not claim a live feedback connection', async () => {
  const submission = ClientSubmission.attach(identity, transcriptId, baseline());
  const reception = { transcriptId, changed() {} };
  submission.stopFollowing();
  await submission.refresh({ read: async () => baseline({ revision: 2 }) }, reception);
  assert.equal(submission.snapshot.feedback.status, 'ended');
  assert.equal(submission.snapshot.remote.revision, 2);
});

test('a successful explicit lookup supersedes an unavailable lookup without inventing a following connection', async () => {
  const submission = ClientSubmission.attach(identity, transcriptId);
  const reception = { transcriptId, changed() {} };
  await assert.rejects(
    submission.refresh(
      {
        read: async () => {
          throw new SubmissionUnavailableError('gone');
        },
      },
      reception,
    ),
  );
  assert.equal(submission.snapshot.feedback.status, 'unavailable');
  await submission.refresh({ read: async () => baseline() }, reception);
  assert.equal(submission.snapshot.feedback.status, 'ended');
  assert.equal(submission.snapshot.remote.submissionId, identity.submissionId);
});
