import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { client, deferred, transport, submissionSnapshot } from './fixtures.mjs';

const input = { messages: [{ role: 'user', content: '问题' }] };
const range = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const wait = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

test('first-frame disconnect retains local identity and only reconnects by follow', async () => {
  let posts = 0;
  let follows = 0;
  let id;
  let accepted = 0;
  const io = transport({
    submit: async (request) => {
      posts++;
      id = request.submissionId;
      throw new TypeError('network');
    },
    follow: async (requested, receive) => {
      follows++;
      assert.equal(requested, id);
      receive(submissionSnapshot(id, { revision: 5, input: range, executions: [{ contextId: 'e' }], answer: { transcriptId: range.transcriptId, index: 3 }, result: { status: 'completed' } }));
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input, () => {
    accepted++;
  });
  const state = runtime.getSnapshot();
  assert.equal(state.submission.id, id);
  assert.equal(state.submission.remote, undefined);
  assert.equal(state.submission.feedback.status, 'interrupted');
  assert.equal(state.error, undefined);
  assert.equal(state.busy, true);
  assert.equal(accepted, 0);
  await assert.rejects(runtime.submit(input), /尚未确认结束/);
  await runtime.reconnectSubmission();
  assert.equal(posts, 1);
  assert.equal(follows, 1);
  assert.equal(accepted, 1);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().messages.length, 0, 'locators do not invent entity content');
  runtime.stopTranscript();
});

test('input-confirmed interruption does not repeat acceptance; later answer and failed result remain separate', async () => {
  let accepted = 0;
  let latest;
  const io = transport({
    submit: async (request, receive) => {
      const d = io.delivery(request, receive);
      d.input();
      d.execution();
      latest = d.snapshot;
      throw new TypeError('after input');
    },
    follow: async (_id, receive) => {
      receive(latest);
      io.appendMessages([{ role: 'assistant', content: '回答' }]);
      receive({ ...latest, revision: 4, answer: { transcriptId: range.transcriptId, index: 1 }, result: { status: 'failed', error: { code: 'POSTPROCESS', message: '后处理失败' } } });
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input, () => {
    accepted++;
  });
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().contextId, 'context-execution-1');
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'interrupted');
  await runtime.reconnectSubmission();
  assert.equal(accepted, 1);
  assert.equal(runtime.getSnapshot().answered, true);
  assert.equal(runtime.getSnapshot().submission.remote.result.error.code, 'POSTPROCESS');
  assert.equal(runtime.getSnapshot().messages[1].content, '回答');
  assert.equal(runtime.getSnapshot().error, undefined);
  runtime.stopTranscript();
});

test('acceptance notification failure cannot reject remote facts or cut off later snapshots', async () => {
  const cause = new Error('UI callback');
  let accepted = 0;
  const io = transport({
    submit: async (request, receive) => {
      const d = io.delivery(request, receive);
      d.input();
      d.execution();
      d.answer();
      d.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input, () => {
    accepted++;
    throw cause;
  });
  assert.equal(accepted, 1);
  assert.equal(runtime.getSnapshot().submission.notificationError, cause);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended');
  assert.equal(runtime.getSnapshot().messages.length, 2);
  runtime.stopTranscript();
});

test('explicitly stopping feedback preserves unresolved submission; release permits new tracking only', async () => {
  const signals = [];
  const io = transport({
    submit: async (_request, _receive, signal) => {
      signals.push(signal);
      await wait(signal);
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  const first = runtime.submit(input);
  const firstId = runtime.getSnapshot().submission.id;
  runtime.stopFollowing();
  await first;
  assert.equal(signals[0].aborted, true);
  assert.equal(runtime.getSnapshot().busy, true);
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended');
  await assert.rejects(runtime.submit(input), /尚未确认结束/);
  runtime.releaseSubmission();
  assert.equal(runtime.getSnapshot().submission, undefined);
  assert.equal(runtime.getSnapshot().busy, false);
  const second = runtime.submit(input);
  assert.notEqual(runtime.getSnapshot().submission.id, firstId);
  runtime.releaseSubmission();
  await second;
  runtime.stopTranscript();
});

test('replaced feedback owner ignores late frames and errors from the former connection', async () => {
  const old = deferred();
  let oldReceive;
  let id;
  const io = transport({
    submit: async (request, receive) => {
      id = request.submissionId;
      oldReceive = receive;
      await old.promise;
    },
    follow: async (_id, receive) => receive(submissionSnapshot(id, { revision: 8, input: range, result: { status: 'completed' } })),
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  const original = runtime.submit(input);
  await runtime.reconnectSubmission();
  oldReceive(submissionSnapshot(id, { revision: 9, result: { status: 'failed', error: { code: 'OLD', message: 'stale' } } }));
  old.reject(new Error('late disconnect'));
  await original;
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(runtime.getSnapshot().submission.remote.revision, 8);
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended');
  runtime.stopTranscript();
});

test('cumulative receiver accepts old versions and revision gaps but rejects conflicts and fact regression', () => {
  const make = () => {
    const submission = new ClientSubmission('test');
    const first = submissionSnapshot(submission.id, { revision: 4, input: range, executions: [{ contextId: 'e1' }] });
    submission.receive(first);
    return { submission, first };
  };
  const { submission, first } = make();
  submission.receive(submissionSnapshot(submission.id, { revision: 1 }));
  submission.receive(first);
  submission.receive({ ...first, revision: 8, executions: [...first.executions, { contextId: 'e2' }], answer: { transcriptId: range.transcriptId, index: 3 } });
  assert.equal(submission.snapshot.remote.revision, 8);
  assert.throws(() => submission.receive({ ...submission.snapshot.remote, input: { ...range, start: 1, end: 2 } }), SubmissionContractError);
  for (const patch of [{ input: undefined }, { input: { ...range, end: 2 } }, { executions: [] }, { executions: [{ contextId: 'other' }] }]) {
    const { submission, first } = make();
    assert.throws(() => submission.receive({ ...first, ...patch, revision: 5 }), SubmissionContractError);
    assert.equal(submission.snapshot.remote.revision, 4);
  }
});

test('remote snapshot copies cannot be mutated by transports after acceptance', () => {
  const submission = new ClientSubmission('test');
  const value = submissionSnapshot(submission.id, { revision: 1, input: { ...range }, executions: [{ contextId: 'e' }] });
  submission.receive(value);
  value.input.end = 5;
  value.executions[0].contextId = 'corrupted';
  assert.equal(submission.snapshot.remote.input.end, 1);
  assert.equal(submission.snapshot.remote.executions[0].contextId, 'e');
  assert.ok(Object.isFrozen(submission.snapshot.remote));
});

test('invalid feedback interrupts its connection without removing valid accepted facts', async () => {
  const io = transport({
    submit: async (request, receive) => {
      const first = submissionSnapshot(request.submissionId, { revision: 1, input: range });
      receive(first);
      receive({ ...first, revision: 2, input: undefined });
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input);
  assert.equal(runtime.getSnapshot().submission.remote.revision, 1);
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'interrupted');
  assert.ok(runtime.getSnapshot().submission.feedback.error instanceof SubmissionContractError);
  assert.equal(runtime.getSnapshot().busy, true);
  runtime.releaseSubmission();
  runtime.stopTranscript();
});

test('incomplete source can subsequently report final outcome without pretending integrity recovered', async () => {
  const integrity = { status: 'incomplete', error: { code: 'PROGRESS_INCOMPLETE', message: 'missing fact' } };
  const io = transport({
    submit: async (request, receive) => receive(submissionSnapshot(request.submissionId, { revision: 2, input: range, integrity })),
    follow: async (id, receive) => receive(submissionSnapshot(id, { revision: 3, input: range, integrity, result: { status: 'failed', error: { code: 'FAILED', message: 'work failed' } } })),
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input);
  assert.equal(runtime.getSnapshot().busy, true);
  await runtime.reconnectSubmission();
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().submission.remote.integrity.status, 'incomplete');
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'failed');
  runtime.stopTranscript();
});

test('submission callback reentrancy cannot send after tracking was released by a subscriber', async () => {
  let posts = 0;
  const io = transport({
    submit: async () => {
      posts++;
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  const unsubscribe = runtime.subscribe(() => {
    if (runtime.getSnapshot().submission) runtime.releaseSubmission();
  });
  await runtime.submit(input);
  unsubscribe();
  assert.equal(posts, 0);
  assert.equal(runtime.getSnapshot().submission, undefined);
  runtime.stopTranscript();
});

test('input facts must belong to the initialized transcript and cannot silently switch conversations', async () => {
  const io = transport({ submit: async (request, receive) => receive(submissionSnapshot(request.submissionId, { revision: 1, input: { ...range, transcriptId: 'foreign' } })) });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input);
  assert.equal(runtime.getSnapshot().submission.remote, undefined);
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'interrupted');
  assert.equal(runtime.getSnapshot().transcriptId, range.transcriptId);
  runtime.releaseSubmission();
  runtime.stopTranscript();
});

test('releasing tracking from formal acceptance cannot let stale completion replace a new submission', async () => {
  let number = 0;
  let second;
  const io = transport({
    submit: async (request, receive) => {
      const current = ++number;
      const d = io.delivery(request, receive);
      d.input();
      d.execution();
      if (current === 2) second = d.snapshot;
      d.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  let next;
  await runtime.submit(input, () => {
    runtime.releaseSubmission();
    next = runtime.submit(input);
  });
  await next;
  assert.equal(runtime.getSnapshot().submission.id, second.submissionId);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  runtime.stopTranscript();
});

test('accidentally asynchronous acceptance notifications are isolated without unhandled rejection or lost facts', async (t) => {
  const unhandled = [];
  const listener = (error) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  let called = 0;
  const io = transport({
    submit: async (request, receive) => {
      const d = io.delivery(request, receive);
      d.input();
      d.execution();
      d.answer();
      d.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input, async () => {
    called++;
    throw new Error('async notification failed');
  });
  const notificationError = runtime.getSnapshot().submission.notificationError;
  assert.ok(notificationError instanceof TypeError);
  assert.match(notificationError.message, /synchronously/);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended');
  assert.equal(runtime.getSnapshot().messages.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, 1);
  assert.deepEqual(unhandled, []);
  assert.equal(runtime.getSnapshot().submission.notificationError, notificationError, 'late promise rejection does not create a second lifecycle');
  runtime.stopTranscript();
});

test('an async acceptance callback cannot overwrite replacement tracking after release and resubmit', async () => {
  let replacement;
  const io = transport({
    submit: async (request, receive) => {
      replacement = request.submissionId;
      const d = io.delivery(request, receive);
      d.input();
      d.execution();
      d.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  let next;
  await runtime.submit(input, async () => {
    runtime.releaseSubmission();
    next = runtime.submit(input);
    await Promise.resolve();
    throw new Error('old async callback');
  });
  await next;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getSnapshot().submission.id, replacement);
  assert.equal(runtime.getSnapshot().submission.notificationError, undefined);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
  runtime.stopTranscript();
});

test('a formal terminal rejection clears the pending display without erasing the submitted preview', async () => {
  const io = transport({
    submit: async (request, receive) => {
      receive(submissionSnapshot(request.submissionId, { revision: 1, result: { status: 'rejected', error: { code: 'BUSY', message: '忙碌' } } }));
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input);
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().submission.pending, input.messages[0].content);
  assert.equal(runtime.getSnapshot().submission.remote.input, undefined);
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().messages.length, 0);
  runtime.stopTranscript();
});

test('reconnection accepts an unchanged cumulative baseline as active feedback without duplicating facts', async () => {
  let baseline;
  let accepted = 0;
  const gate = deferred();
  const io = transport({
    submit: async (request, receive) => {
      baseline = submissionSnapshot(request.submissionId, { revision: 2, input: range });
      receive(baseline);
      throw new Error('disconnected');
    },
    follow: async (_id, receive) => {
      receive(baseline);
      await gate.promise;
      receive({ ...baseline, revision: 3, result: { status: 'completed' } });
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  await runtime.submit(input, () => {
    accepted++;
  });
  const known = runtime.getSnapshot().submission.remote;
  const following = runtime.reconnectSubmission();
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'following');
  assert.equal(runtime.getSnapshot().submission.remote, known);
  assert.equal(accepted, 1);
  gate.resolve();
  await following;
  assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended');
  runtime.stopTranscript();
});
