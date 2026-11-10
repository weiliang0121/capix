import test from 'node:test';

import assert from 'node:assert/strict';

import { ClientSubmission } from '@capix/client-runtime';

import { ConversationHttpTransport } from '@capix/client-http';

import { submissionSnapshot } from './fixtures.mjs';

const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };

const locator = { transcriptId: input.transcriptId, index: 1 };

const create = () => new ClientSubmission('fixture-conversation', { messages: [{ role: 'user', content: 'hello' }] });

const baseline = (submission, preview, patch = {}) => ({ type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 1, input, ...patch }), ...(preview === undefined ? {} : { preview }) });

const change = (submission, value) => ({ type: 'answer', conversationId: submission.conversationId, submissionId: submission.id, change: { generation: 1, ...value } });

test('HTTP keeps malformed optional previews isolated and continues to a known final outcome', async () => {
  const submission = create();
  const frames = [baseline(submission), change(submission, { kind: 'appended', revision: -1, offset: 0, text: 'broken' }), { type: 'baseline', submission: submissionSnapshot(submission.id, { revision: 2, input, answer: locator, result: { status: 'completed' } }) }];
  const transport = new ConversationHttpTransport('', async () => new Response(frames.map((frame) => JSON.stringify(frame)).join('\n')));
  await submission.send(transport, { transcriptId: input.transcriptId, changed() {} });
  assert.equal(submission.snapshot.preview.status, 'failed');
  assert.equal(submission.snapshot.remote.result.status, 'completed');
  assert.equal(submission.snapshot.feedback.status, 'ended');
});
