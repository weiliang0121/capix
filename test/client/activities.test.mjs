import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { client, transport, submissionSnapshot } from './fixtures.mjs';

const input = { messages: [{ role: 'user', content: '问题' }] };
const start = '2026-10-11T00:00:00.000Z';
const end = '2026-10-11T00:00:01.000Z';
const root = () => ({ contextId: 'r', kind: 'scene', label: '本次处理', status: 'running', phase: 'execute', round: 1, startedAt: start });
const child = (contextId, parentContextId, kind, patch = {}) => ({ ...root(), contextId, parentContextId, kind, label: kind, relation: { phase: 'attached' }, ...patch });
const done = (call) => ({ ...call, status: 'succeeded', finishedAt: end });
const activities = (calls, integrity = { status: 'complete' }) => ({ calls, integrity });
const receive = (submission, calls, revision, patch = {}) => submission.receive(submissionSnapshot(submission.id, { revision, activities: activities(calls), ...patch }));

test('cumulative activity reception retains short calls and separates return from parent acceptance', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  const r = root();
  const e = child('e', 'r', 'group');
  receive(submission, [r, e], 2);
  const o = child('o', 'e', 'group');
  const a = done(child('a', 'o', 'node', { relation: { phase: 'returned', returned: 'succeeded' } }));
  receive(submission, [r, e, o, a], 20);
  assert.equal(submission.snapshot.remote.activities.calls.length, 4);
  assert.equal(submission.snapshot.remote.activities.calls[3].relation.phase, 'returned');
  receive(submission, [r, e, o, { ...a, relation: { phase: 'accepted', returned: 'succeeded' } }], 25);
  assert.equal(submission.snapshot.remote.activities.calls[3].relation.phase, 'accepted');
  assert.equal(submission.snapshot.remote.result, undefined);
});

test('activity copies are immutable and exclude undeclared data from a custom transport', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  const calls = [root(), child('e', 'r', 'group')];
  calls[0].input = { credential: 'fixture-only' };
  receive(submission, calls, 1);
  const accepted = submission.snapshot.remote.activities;
  calls[0].label = 'changed';
  calls[1].relation.phase = 'accepted';
  calls.push(child('x', 'e', 'group'));
  assert.equal(accepted.calls[0].label, '本次处理');
  assert.equal(accepted.calls.length, 2);
  assert.equal(accepted.calls[1].relation.phase, 'attached');
  assert.equal('input' in accepted.calls[0], false);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.calls));
  assert.ok(Object.isFrozen(accepted.calls[1].relation));
});

test('duplicate revisions compare accepted activity fields without permitting changed facts', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  const calls = [{ ...root(), input: { ignored: true } }, child('e', 'r', 'group', { relation: { phase: 'attached', source: { ignored: true } } })];
  const snapshot = submissionSnapshot(submission.id, { revision: 4, activities: activities(calls) });
  submission.receive(snapshot);
  const before = submission.snapshot;
  submission.receive(snapshot);
  assert.equal(submission.snapshot, before, 'duplicate transport metadata creates no publication');
  submission.receive({ ...snapshot, activities: activities([{ ...calls[0], input: { ignored: 'changed' } }, calls[1]]) });
  assert.equal(submission.snapshot, before);
  assert.throws(() => submission.receive({ ...snapshot, activities: activities([{ ...calls[0], phase: 'receive' }, calls[1]]) }), SubmissionContractError);
  assert.throws(() => submission.receive({ ...snapshot, activities: activities([calls[0], { ...calls[1], relation: { phase: 'returned', returned: 'succeeded' } }]) }), SubmissionContractError);
  assert.equal(submission.snapshot, before);
  const incomplete = { ...snapshot, revision: 5, activities: activities(calls, { status: 'incomplete', error: { code: 'ACTIVITY_INCOMPLETE', message: '进展停止', detail: { ignored: true } } }) };
  submission.receive(incomplete);
  const retained = submission.snapshot;
  submission.receive(incomplete);
  assert.equal(submission.snapshot, retained);
  submission.receive({ ...incomplete, revision: 6, result: { status: 'completed' } });
  assert.equal(submission.snapshot.remote.result.status, 'completed', 'unknown metadata does not prevent later business results');
});

test('malformed identities, topology and lifecycle boundaries do not partially replace a snapshot', () => {
  const malformed = [[root(), root()], [root(), child('a', 'r', 'node'), child('invalid', 'a', 'group')], [root(), child('o', 'absent', 'group')], [{ ...root(), parentContextId: 'r' }], [{ ...root(), status: 'succeeded' }], [{ ...root(), finishedAt: end }], [{ ...root(), startedAt: 'invalid' }], [{ ...root(), round: -1 }], [root(), child('e', 'r', 'group', { relation: { phase: 'accepted', returned: 'failed' } })]];
  for (const calls of malformed) {
    const submission = new ClientSubmission('fixture-conversation', input);
    receive(submission, [root()], 1);
    const before = submission.snapshot;
    assert.throws(() => receive(submission, calls, 2), SubmissionContractError);
    assert.equal(submission.snapshot, before);
  }
});

test('activity facts cannot disappear, reorder, change parent or revive a terminal call', () => {
  const r = root();
  const e = done(child('e', 'r', 'group', { relation: { phase: 'accepted', returned: 'succeeded' } }));
  const regressed = [[], [r], [e, r], [r, { ...e, label: 'new label' }], [r, { ...e, status: 'running', finishedAt: undefined }], [r, { ...e, status: 'cancelled' }], [r, { ...e, relation: { phase: 'receiving', returned: 'succeeded' } }]];
  for (const calls of regressed) {
    const submission = new ClientSubmission('fixture-conversation', input);
    receive(submission, [r, e], 10);
    assert.throws(() => receive(submission, calls, 11), SubmissionContractError);
  }
  const submission = new ClientSubmission('fixture-conversation', input);
  receive(submission, [r, e], 10);
  assert.throws(() => submission.receive(submissionSnapshot(submission.id, { revision: 11 })), SubmissionContractError);
  receive(submission, [r], 1);
  assert.equal(submission.snapshot.remote.revision, 10, 'old valid revisions are ignored');
});

test('running phases allow skipped and repeated actions while preventing same-round regression', () => {
  const valid = [
    ['setup', 0, 'execute', 1],
    ['execute', 1, 'execute', 1],
    ['execute', 1, 'handling', 1],
    ['receive', 1, 'handling', 1],
    ['handling', 1, 'control', 1],
    ['receive', 1, 'execute', 2],
    ['handling', 1, 'receive', 2],
  ];
  const invalid = [
    ['execute', 1, 'setup', 1],
    ['receive', 1, 'execute', 1],
    ['handling', 1, 'receive', 1],
    ['control', 1, 'handling', 1],
    ['control', 1, 'execute', 2],
    ['control', 1, 'control', 2],
    ['receive', 1, 'setup', 2],
  ];
  for (const [phase, round, nextPhase, nextRound] of valid) {
    const submission = new ClientSubmission('fixture-conversation', input);
    receive(submission, [{ ...root(), phase, round }], 1);
    receive(submission, [{ ...root(), phase: nextPhase, round: nextRound }], 2);
    assert.equal(submission.snapshot.remote.activities.calls[0].phase, nextPhase);
  }
  for (const [phase, round, nextPhase, nextRound] of invalid) {
    const submission = new ClientSubmission('fixture-conversation', input);
    receive(submission, [{ ...root(), phase, round }], 1);
    const before = submission.snapshot;
    assert.throws(() => receive(submission, [{ ...root(), phase: nextPhase, round: nextRound }], 2), SubmissionContractError);
    assert.equal(submission.snapshot, before);
  }
});

test('an independently incomplete activity source retains facts while business delivery completes', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  const r = root();
  const incomplete = activities([r], { status: 'incomplete', error: { code: 'ACTIVITY_INCOMPLETE', message: '进展不可用' } });
  receive(submission, [r], 1);
  submission.receive(submissionSnapshot(submission.id, { revision: 2, activities: incomplete }));
  submission.receive(submissionSnapshot(submission.id, { revision: 3, activities: incomplete, result: { status: 'completed' } }));
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.remote.integrity.status, 'complete');
  assert.equal(submission.snapshot.remote.activities.calls[0].status, 'running', 'do not invent missing call endings');
  assert.throws(() => receive(submission, [done(r)], 4, { result: { status: 'completed' } }), SubmissionContractError);
});

test('cancellation intent never makes running activities terminal', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  receive(submission, [root()], 1);
  receive(submission, [root()], 2, { cancelRequested: true });
  assert.equal(submission.snapshot.remote.activities.calls[0].status, 'running');
  receive(submission, [{ ...root(), status: 'cancelled', finishedAt: end }], 3, { cancelRequested: true, result: { status: 'cancelled' } });
  assert.equal(submission.snapshot.remote.activities.calls[0].status, 'cancelled');
});

test('a retry keeps the failed child and appends a new invocation identity', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  const base = [root(), child('e', 'r', 'group'), child('o', 'e', 'group')];
  const failed = child('a1', 'o', 'node', { status: 'failed', finishedAt: end, relation: { phase: 'returned', returned: 'failed' } });
  receive(submission, [...base, failed], 5);
  const next = [...base];
  next[2] = { ...base[2], round: 2 };
  receive(submission, [...next, failed, child('a2', 'o', 'node')], 8);
  assert.equal(submission.snapshot.remote.activities.calls[3].status, 'failed');
  assert.equal(submission.snapshot.remote.activities.calls[4].contextId, 'a2');
});

test('conversation-only runtime retains completed process states across submissions without altering messages', async () => {
  let posts = 0;
  const io = transport({
    submit: async (request, accept) => {
      posts++;
      const delivery = io.delivery(request, accept);
      delivery.input();
      accept({ ...delivery.snapshot, revision: 10, activities: activities([done({ ...root(), contextId: `r${posts}` })]), result: { status: 'completed' } });
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  try {
    await runtime.submit(input);
    const first = runtime.getSnapshot();
    await runtime.submit(input);
    const second = runtime.getSnapshot();
    assert.equal(second.submissions.size, 2);
    assert.equal(second.submissions.get(first.submission.id).remote.activities.calls[0].contextId, 'r1');
    assert.equal(first.submissions.size, 1, 'previously published maps stay stable');
    assert.equal(second.messages.length, 2, 'only formal user messages are appended');
    assert.equal(second.observation.enabled, false);
    assert.equal(second.busy, false);
  } finally {
    runtime.stopTranscript();
  }
});

test('recent submission retention is bounded, independent from the formal transcript', async () => {
  const io = transport({
    submit: async (request, accept) => {
      const delivery = io.delivery(request, accept);
      delivery.input();
      delivery.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  try {
    let firstId;
    for (let index = 0; index < 34; index++) {
      await runtime.submit(input);
      firstId ??= runtime.getSnapshot().submission.id;
    }
    const state = runtime.getSnapshot();
    assert.equal(state.submissions.size, 32);
    assert.equal(state.submissions.has(firstId), false);
    assert.equal(state.submissions.has(state.submission.id), true);
    assert.equal(state.messages.length, 34);
  } finally {
    runtime.stopTranscript();
  }
});
