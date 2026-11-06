import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';
import { submissionSnapshot } from './fixtures.mjs';

const create = () => new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'hello' }] });
const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const call = (contextId = 'r', patch = {}) => ({ contextId, kind: 'scene', label: '运行', status: 'running', phase: 'execute', round: 1, startedAt: '2026-10-01T00:00:00Z', ...patch });
const baseline = (submission, patch = {}) => ({ type: 'baseline', submission: submissionSnapshot(submission.id, patch) });
const update = (submission, fromRevision, revision, change, patch = {}) => ({ type: 'submission', conversationId: submission.conversationId, submissionId: submission.id, fromRevision, revision, change, ...patch });

test('current tool stages survive reconnect and reject malformed or rewritten facts without deciding the submission result', () => {
  const submission = create();
  const stage = { contextId: 'tool-1', kind: 'tool', label: 'read_message', status: 'running' };
  submission.receiveFrame(baseline(submission, { input }));
  submission.receiveFrame(update(submission, 0, 1, { stage }));
  assert.deepEqual(submission.snapshot.remote.stage, stage);
  assert.equal(submission.snapshot.remote.result, undefined);
  submission.receiveFrame(baseline(submission, { ...submission.snapshot.remote }));
  submission.receiveFrame(update(submission, 1, 2, { stage: { ...stage, status: 'failed' } }));
  assert.equal(submission.snapshot.remote.result, undefined, 'A handled tool failure is not a failed root result');
  const accepted = submission.snapshot.remote;
  for (const bad of [
    { ...stage, status: 'running' },
    { ...stage, label: 'rewritten', status: 'failed' },
    { ...stage, status: 'unknown' },
    { ...stage, contextId: '', status: 'failed' },
  ]) {
    assert.throws(() => submission.receiveFrame(update(submission, 2, 3, { stage: bad })), SubmissionContractError);
    assert.strictEqual(submission.snapshot.remote, accepted);
  }
  submission.receiveFrame(update(submission, 2, 3, { stage: { contextId: 'model-2', kind: 'model', label: '模型处理', status: 'running' } }));
  submission.receiveFrame(update(submission, 3, 4, { result: { status: 'completed' } }));
  assert.equal(submission.snapshot.remote.result.status, 'completed');
});

test('submission changes require a baseline and contiguous revision coverage while stale frames preserve the replica', () => {
  const submission = create();
  assert.throws(() => submission.receiveFrame(update(submission, 0, 1, { input })), SubmissionContractError);
  submission.receiveFrame(baseline(submission));
  submission.receiveFrame(update(submission, 0, 3, { input, executions: [{ contextId: 'e' }] }));
  const accepted = submission.snapshot.remote;
  assert.throws(() => submission.receiveFrame(update(submission, 4, 5, { cancelRequested: true })), SubmissionContractError);
  assert.strictEqual(submission.snapshot.remote, accepted);
  submission.receiveFrame(update(submission, 0, 3, { input }));
  submission.receiveFrame(update(submission, 0, 1, { input }));
  assert.strictEqual(submission.snapshot.remote, accepted);
  assert.throws(() => submission.receiveFrame(update(submission, 0, 1, {}, { conversationId: 'foreign' })), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(update(submission, 0, 1, {}, { submissionId: 'foreign' })), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(update(submission, 3, 3, {})), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(update(submission, 2.5, 4, {})), SubmissionContractError);
});

test('overlapping query baselines merge already attached execution prefixes and call upserts without duplication', () => {
  const submission = create();
  const root = call();
  const execution = call('e', { kind: 'group', parentContextId: 'r', relation: { phase: 'attached' } });
  submission.receiveFrame(baseline(submission, { revision: 2, input, executions: [{ contextId: 'e' }], activities: { calls: [root, execution], integrity: { status: 'complete' } } }));
  const before = submission.snapshot.remote;
  submission.receiveFrame(update(submission, 0, 4, { input, executions: [{ contextId: 'e' }, { contextId: 'e2' }], activities: { calls: [root, { ...execution, phase: 'receive' }, call('e2', { kind: 'group', parentContextId: 'r' })] } }));
  const accepted = submission.snapshot.remote;
  assert.deepEqual(
    accepted.executions.map((entry) => entry.contextId),
    ['e', 'e2'],
  );
  assert.strictEqual(accepted.executions[0], before.executions[0]);
  assert.strictEqual(accepted.activities.calls[0], before.activities.calls[0]);
  assert.equal(accepted.activities.calls[1].phase, 'receive');
  assert.throws(() => submission.receiveFrame(update(submission, 2, 5, { executions: [{ contextId: 'e2' }, { contextId: 'e' }] })), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(update(submission, 2, 5, { activities: { calls: [execution] } })), SubmissionContractError);
  assert.strictEqual(submission.snapshot.remote, accepted);
});

test('activity deltas validate only changed calls and structurally share the other 500 entries', (context) => {
  const submission = create();
  const calls = [call(), ...Array.from({ length: 500 }, (_, index) => call(`e${index}`, { kind: 'group', parentContextId: 'r' }))];
  submission.receiveFrame(baseline(submission, { activities: { calls, integrity: { status: 'complete' } } }));
  const before = submission.snapshot.remote.activities;
  const parse = context.mock.method(Date, 'parse');
  submission.receiveFrame(update(submission, 0, 1, { activities: { calls: [{ ...calls[250], phase: 'receive' }] } }));
  const after = submission.snapshot.remote.activities;
  assert.equal(parse.mock.callCount(), 1, 'unaffected lifecycle timestamps are not revalidated');
  assert.notStrictEqual(before.calls, after.calls);
  assert.notStrictEqual(before.calls[250], after.calls[250]);
  for (let index = 0; index < calls.length; index++) if (index !== 250) assert.strictEqual(after.calls[index], before.calls[index]);
  submission.receiveFrame(update(submission, 1, 2, { cancelRequested: true }));
  assert.strictEqual(submission.snapshot.remote.activities, after);
  assert.equal(parse.mock.callCount(), 1);
});

test('delta acceptance is atomic across small facts, activity changes, and execution indexes', () => {
  const submission = create();
  submission.receiveFrame(baseline(submission, { input, activities: { calls: [call()], integrity: { status: 'complete' } } }));
  const accepted = submission.snapshot.remote;
  assert.throws(() => submission.receiveFrame(update(submission, 0, 1, { executions: [{ contextId: 'e' }], activities: { calls: [call('e', { kind: 'group', parentContextId: 'r' })] }, answer: { transcriptId: input.transcriptId, index: 0 } })), SubmissionContractError);
  assert.strictEqual(submission.snapshot.remote, accepted);
  submission.receiveFrame(update(submission, 0, 1, { executions: [{ contextId: 'e' }], activities: { calls: [call('e', { kind: 'group', parentContextId: 'r' })] }, answer: { transcriptId: input.transcriptId, index: 1 } }));
  assert.equal(submission.snapshot.remote.activities.calls.length, 2);
  assert.equal(submission.snapshot.remote.executions.length, 1);
  assert.throws(() => submission.receiveFrame(update(submission, 1, 2, { input: { ...input, end: 2 } })), SubmissionContractError);
});

test('delta admission clearing, immutable terminal facts, and independently incomplete activities remain separate', () => {
  const submission = create();
  submission.receiveFrame(baseline(submission, { input, admission: { conversationId: submission.conversationId, transcriptId: input.transcriptId, status: 'busy' }, activities: { calls: [call()], integrity: { status: 'complete' } } }));
  const incomplete = { status: 'incomplete', error: { code: 'ACTIVITY_INCOMPLETE', message: 'stopped' } };
  submission.receiveFrame(update(submission, 0, 1, { admission: null, activities: { integrity: incomplete } }));
  assert.equal(submission.snapshot.remote.admission, undefined);
  assert.equal(submission.snapshot.remote.result, undefined);
  assert.throws(() => submission.receiveFrame(update(submission, 1, 2, { activities: { integrity: { status: 'complete' } } })), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(update(submission, 1, 2, { activities: { calls: [call('e', { kind: 'group', parentContextId: 'r' })] } })), SubmissionContractError);
  submission.receiveFrame(update(submission, 1, 2, { result: { status: 'completed' } }));
  assert.deepEqual(submission.snapshot.remote.activities.integrity, incomplete);
  assert.throws(() => submission.receiveFrame(update(submission, 2, 3, { result: { status: 'failed', error: { code: 'LATE', message: 'changed' } } })), SubmissionContractError);
  assert.throws(() => submission.receiveFrame(baseline(submission, { ...submission.snapshot.remote, revision: 2, cancelRequested: true })), SubmissionContractError);
});

test('a newly introduced activity source needs integrity and rejects duplicates, invalid topology, and overflow', () => {
  const submission = create();
  submission.receiveFrame(baseline(submission));
  assert.throws(() => submission.receiveFrame(update(submission, 0, 1, { activities: { calls: [call()] } })), SubmissionContractError);
  for (const calls of [[call(), call()], [call('e', { kind: 'group', parentContextId: 'missing' })], Array.from({ length: 513 }, (_, index) => call(`r${index}`))]) {
    assert.throws(() => submission.receiveFrame(update(submission, 0, 1, { activities: { calls, integrity: { status: 'complete' } } })), SubmissionContractError);
  }
  submission.receiveFrame(update(submission, 0, 1, { activities: { calls: [call()], integrity: { status: 'complete' } } }));
  assert.equal(submission.snapshot.remote.activities.calls.length, 1);
});

test('HTTP accepts real change frames and terminal facts after the connection baseline', async () => {
  const submission = create();
  const frames = [baseline(submission), update(submission, 0, 2, { input, activities: { calls: [call()], integrity: { status: 'complete' } } }), update(submission, 2, 3, { admission: null, result: { status: 'completed' } })];
  const received = [];
  const transport = new ConversationHttpTransport('', async () => new Response(frames.map((frame) => JSON.stringify(frame)).join('\n')));
  await transport.submit(
    { conversationId: submission.conversationId, submissionId: submission.id, input: submission.input },
    (frame) => {
      received.push(frame);
      submission.receiveFrame(frame);
    },
    new AbortController().signal,
  );
  assert.deepEqual(received, frames);
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  for (const frames of [[update(submission, 0, 1, { result: { status: 'completed' } })], [baseline(submission), update(submission, 2, 2, {})], [baseline(submission), update(submission, 0, 1, {}, { conversationId: 'foreign' })]]) {
    const invalid = new ConversationHttpTransport('', async () => new Response(frames.map((frame) => JSON.stringify(frame)).join('\n')));
    await assert.rejects(
      invalid.submit({ conversationId: submission.conversationId, submissionId: submission.id, input: submission.input }, () => {}, new AbortController().signal),
      (error) => error.kind === 'contract',
    );
  }
});

test('equal-revision deltas verify their supplied facts without rescanning unchanged calls', (context) => {
  const submission = create();
  const calls = [call(), call('e', { kind: 'group', parentContextId: 'r' })];
  submission.receiveFrame(baseline(submission, { revision: 5, input, executions: [{ contextId: 'e' }], activities: { calls, integrity: { status: 'complete' } } }));
  const before = submission.snapshot.remote;
  const parse = context.mock.method(Date, 'parse');
  submission.receiveFrame(update(submission, 0, 5, { input, executions: [{ contextId: 'e' }], activities: { calls: [calls[1]] } }));
  assert.strictEqual(submission.snapshot.remote, before);
  assert.equal(parse.mock.callCount(), 1);
  for (const change of [{ cancelRequested: true }, { activities: { calls: [{ ...calls[1], phase: 'receive' }] } }, { executions: [{ contextId: 'new' }] }, { result: { status: 'completed' } }, { admission: { conversationId: submission.conversationId, transcriptId: input.transcriptId, status: 'ready' } }]) {
    assert.throws(() => submission.receiveFrame(update(submission, 0, 5, change)), SubmissionContractError);
    assert.strictEqual(submission.snapshot.remote, before);
  }
  submission.receiveFrame(update(submission, 0, 4, { activities: { calls: [{ ...calls[1], phase: 'setup', round: 0 }] } }));
  assert.strictEqual(submission.snapshot.remote, before, 'strictly older revisions remain safely covered');
});
