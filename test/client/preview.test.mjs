import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSubmission } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';
import { deferred, submissionSnapshot } from './fixtures.mjs';

const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const locator = { transcriptId: input.transcriptId, index: 1 };
const create = () => new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'hello' }] });
const baseline = (submission, preview, patch = {}) => ({ type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 1, input, ...patch }), ...(preview === undefined ? {} : { preview }) });
const change = (submission, value) => ({ type: 'answer', conversationId: submission.conversationId, submissionId: submission.id, change: { generation: 1, ...value } });
const begin = (submission) => {
  submission.receiveFrame(baseline(submission));
  submission.receiveFrame(change(submission, { kind: 'started', revision: 1 }));
};

test('preview accepts UTF-16 offsets and exact duplicate chunks without creating a formal answer', () => {
  const submission = create();
  begin(submission);
  const first = change(submission, { kind: 'appended', revision: 2, offset: 0, text: '你😀' });
  submission.receiveFrame(first);
  submission.receiveFrame(first);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 3, offset: 3, text: '好' }));
  assert.equal(submission.snapshot.preview.snapshot.text, '你😀好');
  assert.equal(submission.snapshot.preview.status, 'live');
  assert.equal(submission.snapshot.remote.answer, undefined);
  assert.equal(submission.snapshot.remote.result, undefined);
  assert.ok(Object.isFrozen(submission.snapshot.preview.snapshot));
});

test('received and committed are distinct and final locator can follow preview before formal body synchronization', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'answer' }));
  submission.receiveFrame(change(submission, { kind: 'received', revision: 3 }));
  assert.equal(submission.snapshot.remote.answer, undefined);
  submission.receiveFrame(change(submission, { kind: 'committed', revision: 4, message: locator, consistency: 'complete' }));
  submission.receiveFrame(baseline(submission, submission.snapshot.preview.snapshot, { revision: 2, answer: locator, result: { status: 'completed' } }));
  assert.equal(submission.snapshot.preview.snapshot.state, 'committed');
  assert.deepEqual(submission.snapshot.remote.answer, locator);
});

test('revision gaps preserve the candidate and a matching baseline restores only preview reception', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 3, offset: 2, text: 'cd' }));
  assert.equal(submission.snapshot.preview.status, 'interrupted');
  submission.receiveFrame(baseline(submission, { generation: 1, revision: 3, text: 'abcd', state: 'streaming' }));
  assert.equal(submission.snapshot.preview.status, 'live');
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 4, offset: 4, text: 'e' }));
  assert.equal(submission.snapshot.preview.snapshot.text, 'abcde');
});

test('a delayed query baseline cannot claim to have repaired a later preview gap', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 4, offset: 4, text: 'ef' }));
  submission.receiveFrame(baseline(submission));
  submission.receiveFrame(baseline(submission, { generation: 1, revision: 2, text: 'ab', state: 'streaming' }));
  assert.equal(submission.snapshot.preview.status, 'interrupted');
  assert.equal(submission.snapshot.preview.snapshot.text, 'ab');
  submission.receiveFrame(baseline(submission, { generation: 1, revision: 4, text: 'abcdef', state: 'streaming' }));
  assert.equal(submission.snapshot.preview.status, 'live');
  assert.equal(submission.snapshot.preview.snapshot.text, 'abcdef');
});

test('conflicting preview data remains failed across baselines while formal result is still accepted', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'abc' }));
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'xyz' }));
  assert.equal(submission.snapshot.preview.status, 'failed');
  submission.receiveFrame(baseline(submission, { generation: 1, revision: 5, text: 'xyz', state: 'committed', message: locator, consistency: 'complete' }, { revision: 2, answer: locator, result: { status: 'completed' } }));
  assert.equal(submission.snapshot.preview.status, 'failed');
  assert.equal(submission.snapshot.preview.snapshot.text, 'abc');
  assert.equal(submission.snapshot.remote.result.status, 'completed');
});

test('a replacement generation starts a fresh prefix and late former-generation data cannot corrupt it', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'rejected' }));
  submission.receiveFrame(change(submission, { kind: 'discarded', revision: 3, reason: 'rejected' }));
  submission.receiveFrame(change(submission, { kind: 'started', generation: 2, revision: 1 }));
  submission.receiveFrame(change(submission, { kind: 'appended', generation: 2, revision: 2, offset: 0, text: 'accepted' }));
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'old' }));
  assert.equal(submission.snapshot.preview.snapshot.text, 'accepted');
  assert.equal(submission.snapshot.preview.snapshot.generation, 2);
  assert.equal(submission.snapshot.preview.status, 'live');
});

test('cancellation retains partial text without promoting it to an accepted message', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'partial' }));
  submission.receiveFrame(change(submission, { kind: 'discarded', revision: 3, reason: 'cancelled' }));
  submission.receiveFrame({ type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 2, input, cancelRequested: true, result: { status: 'cancelled' } }) });
  assert.equal(submission.snapshot.preview.snapshot.text, 'partial');
  assert.equal(submission.snapshot.preview.snapshot.reason, 'cancelled');
  assert.equal(submission.snapshot.remote.answer, undefined);
});

test('a preview location conflict is isolated from formal facts and an earlier empty baseline is harmless', () => {
  const submission = create();
  begin(submission);
  submission.receiveFrame(change(submission, { kind: 'appended', revision: 2, offset: 0, text: 'abc' }));
  submission.receiveFrame(baseline(submission));
  assert.equal(submission.snapshot.preview.snapshot.text, 'abc');
  submission.receiveFrame(change(submission, { kind: 'received', revision: 3 }));
  submission.receiveFrame(change(submission, { kind: 'committed', revision: 4, message: { ...locator, transcriptId: 'foreign' }, consistency: 'prefix' }));
  assert.equal(submission.snapshot.preview.status, 'failed');
  submission.receiveFrame({ type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 2, input, answer: locator, result: { status: 'completed' } }) });
  assert.deepEqual(submission.snapshot.remote.answer, locator);
});

test('delta transitions cannot skip reception, replace an active generation or repeat completion', () => {
  for (const invalid of [
    [{ kind: 'committed', revision: 2, message: locator, consistency: 'complete' }],
    [{ kind: 'started', generation: 2, revision: 1 }],
    [
      { kind: 'received', revision: 2 },
      { kind: 'received', revision: 3 },
    ],
  ]) {
    const submission = create();
    begin(submission);
    for (const event of invalid) submission.receiveFrame(change(submission, event));
    assert.equal(submission.snapshot.preview.status, 'failed');
    assert.equal(submission.snapshot.remote.result, undefined);
  }
  const submission = create();
  begin(submission);
  submission.receiveFrame(baseline(submission, { generation: 1, revision: 8, text: 'complete', state: 'committed', message: locator, consistency: 'complete' }, { revision: 2, answer: locator }));
  assert.equal(submission.snapshot.preview.status, 'live', 'a cumulative baseline may legitimately skip unseen intermediate events');
});

test('a gap queries the same submission baseline without resending or interrupting active feedback', async () => {
  const submission = create();
  const release = deferred();
  let receives;
  let reads = 0;
  const work = submission.connect(
    async (receive) => {
      receives = receive;
      receive(baseline(submission));
      receive(change(submission, { kind: 'started', revision: 1 }));
      receive(change(submission, { kind: 'appended', revision: 3, offset: 2, text: 'cd' }));
      await release.promise;
    },
    {
      transcriptId: input.transcriptId,
      changed() {},
      recoverPreview: async () => {
        reads++;
        return baseline(submission, { generation: 1, revision: 3, text: 'abcd', state: 'streaming' });
      },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(submission.snapshot.preview.status, 'live');
  assert.equal(submission.snapshot.preview.snapshot.text, 'abcd');
  receives(change(submission, { kind: 'discarded', revision: 4, reason: 'failed' }));
  receives({ type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 2, input, result: { status: 'failed', error: { code: 'GENERATION', message: 'failed' } } }) });
  release.resolve();
  await work;
  assert.equal(submission.snapshot.feedback.status, 'ended');
});

test('HTTP keeps malformed optional previews isolated and continues to a known final outcome', async () => {
  const submission = create();
  const frames = [baseline(submission), change(submission, { kind: 'appended', revision: -1, offset: 0, text: 'broken' }), { type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 2, input, answer: locator, result: { status: 'completed' } }) }];
  const transport = new ConversationHttpTransport('', async () => new Response(frames.map((frame) => JSON.stringify(frame)).join('\n')));
  await submission.send(transport, { transcriptId: input.transcriptId, changed() {} });
  assert.equal(submission.snapshot.preview.status, 'failed');
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.feedback.status, 'ended');
});
