import test from 'node:test';

import assert from 'node:assert/strict';

import { ClientSubmission } from '@capix/client-runtime';

import { ConversationHttpTransport } from '@capix/client-http';

import { submissionSnapshot } from './fixtures.mjs';

const create = () => new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'hello' }] });

const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };

const call = (contextId = 'r', patch = {}) => ({ contextId, kind: 'scene', label: '运行', status: 'running', phase: 'execute', round: 1, startedAt: '2026-10-01T00:00:00Z', ...patch });

const baseline = (submission, patch = {}) => ({ type: 'baseline', submission: submissionSnapshot(submission.id, patch) });

const update = (submission, fromRevision, revision, change, patch = {}) => ({ type: 'submission', conversationId: submission.conversationId, submissionId: submission.id, fromRevision, revision, change, ...patch });

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
