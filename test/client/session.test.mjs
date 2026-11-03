import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationSession, SessionConnectionError, SubmissionUnavailableError } from '@capix/client-runtime';

const identity = { conversationId: 'conversation', transcriptId: 'transcript' };
const admission = (status = 'ready') => ({ ...identity, status });
const info = () => ({ ...identity, mode: 'demo', model: 'offline', admission: admission() });
const baseline = (submissionId, patch = {}) => ({ type: 'baseline', submission: { conversationId: identity.conversationId, submissionId, revision: 1, executions: [], integrity: { status: 'complete' }, ...patch } });
const input = { transcriptId: identity.transcriptId, start: 0, end: 1 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

function setup(t, overrides = {}, remembered) {
  const posts = [],
    reads = [],
    follows = [],
    cancels = [];
  let tracking = remembered;
  let receiveTranscript;
  let entity = { id: identity.transcriptId, revision: 0, start: 0, end: 0, starts: [0], messages: [] };
  const transport = {
    session: async () => info(),
    transcript: async () => entity,
    observeTranscript: async (_id, receive, signal) => {
      receiveTranscript = receive;
      receive({ type: 'baseline', snapshot: entity });
      await wait(signal);
    },
    read: async (id) => {
      reads.push(id);
      return baseline(id, { input });
    },
    follow: async (id, receive, signal) => {
      follows.push(id);
      receive(baseline(id, { input }));
      await wait(signal);
    },
    submit: async (request, receive) => {
      posts.push(request);
      receive(baseline(request.submissionId, { result: { status: 'failed', error: { code: 'OFFLINE', message: 'offline' } }, admission: admission() }));
    },
    cancel: async (id) => {
      cancels.push(id);
      return baseline(id, { revision: 2, input, cancelRequested: true });
    },
    inspection: async () => {
      throw new Error('Not part of automatic session synchronization');
    },
    call: async () => {
      throw new Error('Not part of automatic session synchronization');
    },
    ...overrides,
  };
  const session = new ConversationSession(transport, {
    tracking: {
      load: () => tracking,
      save: (value) => {
        tracking = value;
      },
    },
  });
  t.after(() => session.stop());
  return {
    session,
    transport,
    posts,
    reads,
    follows,
    cancels,
    get tracking() {
      return tracking;
    },
    append(messages) {
      const start = entity.end;
      entity = { ...entity, revision: entity.revision + 1, end: start + messages.length, messages: [...entity.messages, ...messages] };
      receiveTranscript({ type: 'delta', event: { type: 'transcript', transcriptId: entity.id, revision: entity.revision, occurredAt: new Date().toISOString(), change: { kind: 'messages-appended', start, messages } } });
    },
  };
}

test('session separates accepted text synchronization from submission terminal facts', async (t) => {
  let deliver;
  const f = setup(t, {
    submit: async (request, receive, signal) => {
      assert.equal(f.tracking.submissionId, request.submissionId);
      f.posts.push(request);
      deliver = (patch) => receive(baseline(request.submissionId, patch));
      deliver({ input, admission: admission('busy') });
      await wait(signal);
    },
  });
  await f.session.initialize();
  assert.equal(f.session.snapshot.canSend, true);
  const sending = f.session.send('hello');
  assert.equal(f.session.snapshot.canSend, false);
  assert.equal(f.posts.length, 1);
  await assert.rejects(f.session.send('duplicate'), /尚不可提交/);
  f.append([{ role: 'user', content: 'hello' }]);
  deliver({ revision: 2, input, answer: { transcriptId: identity.transcriptId, index: 1 }, result: { status: 'completed' }, admission: admission() });
  assert.equal(f.session.snapshot.submission.remote.result.status, 'completed');
  assert.equal(f.session.snapshot.canSend, false, 'missing formal answer body is not ready');
  f.append([{ role: 'assistant', content: 'world' }]);
  await tick();
  assert.equal(f.session.snapshot.canSend, true);
  assert.equal(f.tracking.submissionId, undefined);
  f.session.stop();
  await sending;
  assert.deepEqual(f.cancels, []);
});

test('refresh attaches persisted or service-discovered submission and never reposts', async (t) => {
  for (const persisted of [true, false]) {
    const active = baseline('existing', { input, admission: admission('busy') });
    const f = setup(
      t,
      {
        session: async () => ({ ...info(), admission: admission('busy'), active }),
        read: async (id) => {
          f.reads.push(id);
          return active;
        },
        follow: async (id, receive, signal) => {
          f.follows.push(id);
          receive(active);
          await wait(signal);
        },
      },
      persisted ? { ...identity, submissionId: 'existing' } : undefined,
    );
    await f.session.initialize();
    await tick();
    assert.deepEqual(f.reads, ['existing']);
    assert.deepEqual(f.follows, ['existing']);
    assert.deepEqual(f.posts, []);
    assert.equal(f.session.snapshot.submission.pending, undefined);
    assert.equal(f.session.snapshot.canSend, false);
    f.session.stop();
    await f.session.initialize();
    await tick();
    assert.deepEqual(f.follows, ['existing', 'existing']);
    assert.deepEqual(f.posts, []);
    assert.deepEqual(f.cancels, []);
  }
});

test('a short POST interruption reads and follows the same identity without replaying input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(t, {
    submit: async (request) => {
      f.posts.push(request);
      throw new SessionConnectionError('connection lost');
    },
    follow: async (id, receive) => {
      f.follows.push(id);
      receive(baseline(id, { revision: 2, input, result: { status: 'failed', error: { code: 'MODEL', message: 'failed' } }, admission: admission() }));
    },
  });
  await f.session.initialize();
  const sending = f.session.send('original');
  await tick();
  assert.equal(f.session.snapshot.submission.feedback.status, 'interrupted');
  t.mock.timers.tick(300);
  await sending;
  const id = f.posts[0].submissionId;
  assert.deepEqual(f.reads, [id]);
  assert.deepEqual(f.follows, [id]);
  assert.equal(f.posts.length, 1);
  assert.equal(f.session.snapshot.submission.remote.result.status, 'failed');
  assert.equal(f.session.snapshot.canSend, true);
});

test('restart unknown stays unconfirmed until explicit local forget and fresh admission', async (t) => {
  const f = setup(
    t,
    {
      read: async (id) => {
        f.reads.push(id);
        throw new SubmissionUnavailableError('process restarted');
      },
    },
    { ...identity, submissionId: 'unknown' },
  );
  await f.session.initialize();
  await tick();
  assert.equal(f.session.snapshot.submission.feedback.status, 'unavailable');
  assert.equal(f.session.snapshot.submission.remote, undefined);
  assert.equal(f.session.snapshot.canSend, false);
  assert.equal(f.tracking.submissionId, 'unknown');
  await assert.rejects(f.session.send('new input'), /尚不可提交/);
  f.session.forget();
  await tick();
  assert.equal(f.session.snapshot.submission, undefined);
  assert.equal(f.session.snapshot.canSend, true);
  assert.equal(f.tracking.submissionId, undefined);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.cancels, []);
  assert.deepEqual(f.reads, ['unknown']);
});

test('cancel acknowledgement is distinct from cancellation result and stop never cancels', async (t) => {
  let deliver;
  const f = setup(
    t,
    {
      follow: async (id, receive, signal) => {
        f.follows.push(id);
        deliver = receive;
        await wait(signal);
      },
    },
    { ...identity, submissionId: 'existing' },
  );
  await f.session.initialize();
  await tick();
  await f.session.cancel();
  assert.deepEqual(f.cancels, ['existing']);
  assert.equal(f.session.snapshot.submission.cancellation.status, 'acknowledged');
  assert.equal(f.session.snapshot.submission.remote.result, undefined);
  assert.equal(f.session.snapshot.canSend, false);
  deliver(baseline('existing', { revision: 3, input, cancelRequested: true, result: { status: 'cancelled' }, admission: admission() }));
  await tick();
  assert.equal(f.session.snapshot.submission.remote.result.status, 'cancelled');
  assert.equal(f.session.snapshot.canSend, true);
  f.session.stop();
  assert.deepEqual(f.cancels, ['existing']);
});

test('identity changes and protocol failures are terminal rather than automatic retry or replacement', async (t) => {
  const f = setup(t);
  await f.session.initialize();
  f.append([{ role: 'user', content: 'keep me' }]);
  f.transport.session = async () => ({ ...info(), transcriptId: 'different', admission: { ...admission(), transcriptId: 'different' } });
  await assert.rejects(f.session.reconnect(), /身份已改变/);
  assert.equal(f.session.snapshot.status, 'failed');
  assert.equal(f.session.snapshot.transcript.snapshot.messages[0].content, 'keep me');
  assert.equal(f.session.snapshot.canSend, false);

  const g = setup(
    t,
    {
      read: async (id) => {
        g.reads.push(id);
        return baseline(id, { conversationId: 'wrong' });
      },
    },
    { ...identity, submissionId: 'broken' },
  );
  await g.session.initialize();
  await tick();
  assert.equal(g.session.snapshot.submission.feedback.status, 'interrupted');
  assert.deepEqual(g.reads, ['broken']);
  assert.deepEqual(g.follows, []);
  assert.deepEqual(g.posts, []);
});

test('reconnect attempts are bounded and malformed user input never sends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(
    t,
    {
      read: async (id) => {
        f.reads.push(id);
        throw new SessionConnectionError('offline');
      },
    },
    { ...identity, submissionId: 'offline' },
  );
  await f.session.initialize();
  await tick();
  for (const delay of [300, 1000, 2500, 100_000]) {
    t.mock.timers.tick(delay);
    await tick();
  }
  assert.equal(f.reads.length, 4);
  assert.equal(f.session.snapshot.submission.feedback.status, 'interrupted');
  assert.deepEqual(f.posts, []);
  for (const value of ['', '   ', 'x'.repeat(256 * 1024 + 1)]) await assert.rejects(f.session.send(value), TypeError);
});

test('an obsolete tracking identity needs explicit release but does not permanently block startup', async (t) => {
  const f = setup(t, {}, { conversationId: 'old-conversation', transcriptId: 'old-transcript', submissionId: 'unknown' });
  await assert.rejects(f.session.initialize(), /本地跟踪属于其他对话/);
  assert.equal(f.session.snapshot.submission, undefined);
  assert.equal(f.session.snapshot.canForget, true);
  assert.equal(f.tracking.submissionId, 'unknown');
  f.session.forget();
  await tick();
  assert.equal(f.session.snapshot.canSend, true);
  assert.equal(f.session.snapshot.canForget, false);
  assert.deepEqual(f.tracking, identity);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.reads, []);
});

test('input limits account for UTF-8 and JSON escaping before creating local submission state', async (t) => {
  const f = setup(t);
  await f.session.initialize();
  for (const text of ['中'.repeat(44_000), '"'.repeat(70_000), 'x'.repeat(128 * 1024)]) await assert.rejects(f.session.send(text), /128 KiB/);
  assert.deepEqual(f.posts, []);
  assert.equal(f.session.snapshot.submission, undefined);
  assert.equal(f.session.snapshot.canSend, true);
});

test('busy rejection discovers the other tab active submission and follows its completion', async (t) => {
  let busy = false;
  let acceptActive;
  const active = baseline('other-tab', { input, admission: admission('busy') });
  const f = setup(t, {
    session: async () => (busy ? { ...info(), admission: admission('busy'), active } : info()),
    submit: async (request, receive) => {
      f.posts.push(request);
      busy = true;
      receive(baseline(request.submissionId, { result: { status: 'rejected', error: { code: 'BUSY', message: 'busy' } }, admission: admission('busy') }));
    },
    read: async (id) => {
      f.reads.push(id);
      return active;
    },
    follow: async (id, receive, signal) => {
      f.follows.push(id);
      acceptActive = receive;
      receive(active);
      await wait(signal);
    },
  });
  await f.session.initialize();
  await assert.rejects(f.session.send('own request'), /busy/);
  await tick();
  assert.equal(f.session.snapshot.submission.id, 'other-tab');
  assert.equal(f.session.snapshot.info.admission.status, 'busy');
  assert.equal(f.session.snapshot.canSend, false);
  busy = false;
  acceptActive(baseline('other-tab', { revision: 2, input, result: { status: 'failed', error: { code: 'MODEL', message: 'failed' } }, admission: admission() }));
  await tick();
  assert.equal(f.session.snapshot.canSend, true);
  assert.deepEqual(f.follows, ['other-tab']);
  assert.equal(f.posts.length, 1);
});

test('historical terminal admission cannot override a newer active service submission', async (t) => {
  const active = baseline('current', { input, admission: admission('busy') });
  const f = setup(
    t,
    {
      session: async () => ({ ...info(), admission: admission('busy'), active }),
      read: async (id) => {
        f.reads.push(id);
        return id === 'historical' ? baseline(id, { cancelRequested: true, result: { status: 'cancelled' }, admission: admission() }) : active;
      },
      follow: async (id, receive, signal) => {
        f.follows.push(id);
        receive(active);
        await wait(signal);
      },
    },
    { ...identity, submissionId: 'historical' },
  );
  await f.session.initialize();
  await tick();
  assert.equal(f.session.snapshot.submission.id, 'current');
  assert.equal(f.session.snapshot.info.admission.status, 'busy');
  assert.equal(f.session.snapshot.canSend, false);
  assert.deepEqual(f.reads, ['historical', 'current']);
  assert.deepEqual(f.follows, ['current']);
  assert.deepEqual(f.posts, []);
});
