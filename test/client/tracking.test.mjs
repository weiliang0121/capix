import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix/client-runtime';
import { conversationDescriptor, deferred, submissionSnapshot, transcriptSnapshot, transport } from './fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const identity = { conversationId: 'fixture-conversation', transcriptId: 'fixture-transcript' };
const input = { messages: [{ role: 'user', content: 'private request body' }] };
const baseline = (id, patch = {}) => ({ type: 'baseline', submission: submissionSnapshot(id, patch) });

function store(value) {
  const writes = [];
  return {
    writes,
    load: () => value,
    save(locator) {
      value = locator;
      writes.push(locator);
    },
  };
}

function client(t, io, tracking) {
  const runtime = new ClientRuntime({ conversation: io, transcripts: io, tracking });
  t.after(() => {
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
  });
  return runtime;
}

test('local storage contains only the current locator, saved before POST and cleared only after a confirmed result', async (t) => {
  const tracking = store();
  let delivery;
  const io = transport({
    submit: async (request, receive, signal) => {
      assert.deepEqual(tracking.load(), { ...identity, submissionId: request.submissionId });
      delivery = io.delivery(request, receive);
      delivery.input();
      await wait(signal);
    },
  });
  const runtime = client(t, io, tracking);
  await runtime.initialize();
  const work = runtime.submit(input);
  await settle();
  runtime.enqueue(input);
  assert.equal(tracking.writes.length, 2);
  assert.deepEqual(Object.keys(tracking.load()).sort(), ['conversationId', 'submissionId', 'transcriptId']);
  runtime.clearQueue();
  runtime.stopFollowing();
  await work;
  assert.ok(tracking.load().submissionId, 'a locally stopped connection cannot erase the remote locator');
  io.read = async () => baseline(tracking.load().submissionId, { revision: 2, input: { transcriptId: identity.transcriptId, start: 0, end: 1 }, result: { status: 'failed', error: { code: 'TEST', message: 'failed' } } });
  await runtime.refreshSubmission();
  assert.deepEqual(tracking.load(), identity);
});

test('an active service submission can be discovered without a local request or stored identity', async (t) => {
  const follows = [];
  const io = transport({
    activeSubmission: async () => ({ ...identity, submission: baseline('existing') }),
    follow: async (id, receive, signal) => {
      follows.push(id);
      receive(baseline(id));
      await wait(signal);
    },
    submit: async () => assert.fail('discovery cannot create business work'),
  });
  const runtime = client(t, io);
  await runtime.initialize();
  assert.deepEqual(follows, ['existing']);
  assert.equal(runtime.getSnapshot().submission.queueId, undefined);
  assert.equal(runtime.getSnapshot().submission.pending, undefined);
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().canSwitchConversation, false);
});

test('configuration initialization may fail after attachment and retry reuses the same tracked submission', async (t) => {
  const config = deferred();
  let configurationCalls = 0;
  const io = transport({
    config: () => (++configurationCalls === 1 ? config.promise : Promise.resolve({ configured: true, model: 'fixture', contextBudget: 1024 })),
    read: async () => baseline('existing'),
    follow: async (id, receive, signal) => {
      receive(baseline(id));
      await wait(signal);
    },
  });
  const runtime = client(t, io, store({ ...identity, submissionId: 'existing' }));
  const first = runtime.initialize();
  await settle();
  assert.equal(runtime.getSnapshot().submission.id, 'existing');
  config.reject(new Error('configuration offline'));
  await assert.rejects(first, /configuration offline/);
  await runtime.initialize();
  assert.equal(runtime.getSnapshot().initialization.status, 'succeeded');
  assert.equal(runtime.getSnapshot().submission.id, 'existing');
});

test('stopping initialization cancels its pending submission query and ignores late failure until an explicit retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  let reads = 0;
  let firstSignal;
  let follows = 0;
  const io = transport({
    read: async (_id, signal) => {
      reads++;
      if (reads === 1) {
        firstSignal = signal;
        return pending.promise;
      }
      return baseline('existing');
    },
    follow: async (id, receive, signal) => {
      follows++;
      receive(baseline(id));
      await wait(signal);
    },
  });
  const runtime = client(t, io, store({ ...identity, submissionId: 'existing' }));
  const initializing = runtime.initialize();
  await settle();
  assert.equal(reads, 1);
  runtime.stopTranscript();
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(firstSignal.aborted, true);
  pending.reject(new Error('late network failure'));
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(reads, 1);
  assert.equal(follows, 0);
  assert.equal(runtime.getSnapshot().initialization.status, 'stopped');
  await runtime.initialize();
  assert.equal(reads, 2);
  assert.equal(follows, 1);
});

test('invalid discovered facts do not change the selected conversation or close its synchronized copy', async (t) => {
  const target = conversationDescriptor('other', 'other-transcript');
  const io = transport({
    conversation: async () => target,
    activeSubmission: async (id) => (id === target.id ? { conversationId: id, transcriptId: target.transcriptId, submission: baseline('bad', { conversationId: id, revision: -1 }) } : identity),
    observeTranscript: async (id, receive, signal) => {
      receive({ type: 'baseline', snapshot: transcriptSnapshot([], id) });
      await wait(signal);
    },
  });
  const tracking = store();
  const runtime = client(t, io, tracking);
  await runtime.initialize();
  await assert.rejects(runtime.openConversation(target.id));
  await settle();
  assert.equal(runtime.getSnapshot().conversation.id, identity.conversationId);
  assert.equal(runtime.getSnapshot().transcripts.get(identity.transcriptId).sync.status, 'live');
  assert.equal(runtime.getSnapshot().submission, undefined);
  assert.deepEqual(tracking.load(), identity);
});

test('storage failure does not fail submission and is not retried on every unchanged progress identity', async (t) => {
  let writes = 0;
  let delivery;
  const failure = new Error('storage unavailable');
  const io = transport({
    submit: async (request, receive, signal) => {
      delivery = io.delivery(request, receive);
      delivery.input();
      await wait(signal);
    },
  });
  const runtime = client(t, io, {
    load: () => {
      throw failure;
    },
    save: () => {
      writes++;
      throw failure;
    },
  });
  await runtime.initialize();
  const work = runtime.submit(input);
  await settle();
  const before = writes;
  delivery.execution('one');
  delivery.execution('two');
  await settle();
  assert.equal(writes, before);
  assert.equal(runtime.getSnapshot().trackingError, failure);
  assert.equal(runtime.getSnapshot().submission.remote.executions.length, 2);
  runtime.stopFollowing();
  await work;
});
