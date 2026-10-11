import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { projectResponses } from '../../apps/observer/.test-dist/binding/responses.js';

const task = { sourcePath: 'notes.md', output: { path: 'summary.md' } };

test('binding captures and clears file drafts only after local acceptance', async () => {
  const store = createAppStore();
  store.getState().setDraft('总结');
  store.getState().setFileDraft({ sourcePath: 'notes.md', outputPath: 'summary.md' });
  let received;
  const runtime = {
    getSnapshot: () => ({ config: { configured: true, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } }, queue: { waiting: [] } }),
    enqueue: (input) => {
      received = input;
      return { id: 'queued' };
    },
  };
  await submitDraft(store, runtime);
  assert.deepEqual(received.fileTask, task);
  assert.deepEqual(store.getState().fileDraft, { sourcePath: '', outputPath: '' });
  store.getState().setDraft('再试');
  store.getState().setFileDraft({ sourcePath: 'notes.md', outputPath: '' });
  runtime.enqueue = () => {
    throw new Error('满了');
  };
  await submitDraft(store, runtime);
  assert.equal(store.getState().fileDraft.sourcePath, 'notes.md');
  assert.equal(store.getState().draft, '再试');
  assert.equal(store.getState().notice, '满了');
});

test('binding rejects stale file draft if service file capability is unavailable', async () => {
  const store = createAppStore();
  store.getState().setDraft('总结');
  store.getState().setFileDraft({ sourcePath: 'notes.md', outputPath: '' });
  await submitDraft(store, { getSnapshot: () => ({ config: { configured: true } }), enqueue: () => assert.fail('No submission') });
  assert.match(store.getState().notice, /未启用/);
  assert.equal(store.getState().fileDraft.sourcePath, 'notes.md');
});

test('binding supports explicit create-only tasks and leaves natural-language decisions to the service', async () => {
  const store = createAppStore();
  const sent = [];
  const runtime = {
    getSnapshot: () => ({ config: { configured: true, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } }, queue: { waiting: [] } }),
    enqueue: (input) => {
      sent.push(input);
      return { id: String(sent.length) };
    },
  };
  store.getState().setDraft('摘录李白的诗');
  store.getState().setFileDraft({ sourcePath: '', outputPath: 'poem.md' });
  await submitDraft(store, runtime);
  assert.deepEqual(sent[0].fileTask, { output: { path: 'poem.md' } });
  store.getState().setDraft('把 notes.md 翻译成白话文并保存为 translation.md');
  await submitDraft(store, runtime);
  assert.equal(sent[1].fileTask, undefined, 'binding does not infer file actions from text');
});

test('projection keeps file receipt without an answer and independently of postprocessing diagnostics', () => {
  const receipt = { path: 'summary.md', bytes: 30, digest: 'a'.repeat(64) };
  const submission = { id: 's', queueId: 'q', pending: '总结', fileTask: task, feedback: { status: 'ended' }, remote: { submissionId: 's', revision: 3, input: { transcriptId: 't', start: 0, end: 1 }, executions: [], fileOutput: { status: 'created', receipt }, integrity: { status: 'complete' }, result: { status: 'failed', error: { code: 'FAILURE', message: 'after commit' } } } };
  const input = { key: 'm0', index: 0, message: { role: 'user', content: '总结' } };
  const rows = projectResponses([input], { transcriptId: 't', submission, submissions: new Map([['s', submission]]), transcripts: new Map(), queue: { waiting: [] } });
  const response = rows.find((row) => row.kind === 'response');
  assert.deepEqual(response.fileTask, task);
  assert.deepEqual(response.fileOutput, { status: 'created', receipt });
  assert.equal(response.body, undefined);
  assert.equal(response.afterInputKey, 'm0');
});

test('response projection displays service-selected file scope and file failure alongside a preserved answer', () => {
  const selected = { output: { path: 'poem.md' } };
  const submission = { id: 's', queueId: 'q', pending: '保存诗', feedback: { status: 'ended' }, remote: { submissionId: 's', revision: 8, input: { transcriptId: 't', start: 0, end: 1 }, answer: { transcriptId: 't', index: 1 }, task: { kind: 'file', task: selected }, executions: [], fileOutput: { status: 'not-created', path: 'poem.md', reason: 'failed' }, integrity: { status: 'complete' }, result: { status: 'failed', error: { code: 'FILE_ACCESS', message: 'private detail must not enter result card' } } } };
  const messages = [
    { key: 'm0', index: 0, message: { role: 'user', content: '保存诗' } },
    { key: 'm1', index: 1, message: { role: 'assistant', content: '床前明月光' } },
  ];
  const state = { transcriptId: 't', submission, submissions: new Map([['s', submission]]), transcripts: new Map(), queue: { waiting: [] } };
  const response = projectResponses(messages, state).find((row) => row.kind === 'response');
  assert.deepEqual(response.fileTask, selected);
  assert.equal(response.body.message.content, '床前明月光');
  assert.equal(response.fileOutput.reason, 'failed');
  assert.equal(response.notice, undefined, 'generic postprocessing diagnostic stays hidden; FileResult owns output failure');
  const clarification = { ...submission, fileTask: task, remote: { ...submission.remote, task: { kind: 'clarify' }, fileOutput: undefined } };
  const clarified = projectResponses(messages, { ...state, submission: clarification, submissions: new Map([['s', clarification]]) }).find((row) => row.kind === 'response');
  assert.equal(clarified.fileTask, undefined, 'accepted clarification does not still imply planned file creation');
});

test('actionable file failures preserve their public explanation only when no answer was committed', async () => {
  const { projectSubmission } = await import('../../apps/observer/.test-dist/binding/submission.js');
  for (const message of ['文件或所在目录不可用。', '文件内容必须是有效的 UTF-8 文本。', '输出文件已存在，未覆盖原文件。']) {
    const submission = { id: 's', queueId: 'q', pending: '总结', fileTask: task, feedback: { status: 'ended' }, remote: { submissionId: 's', revision: 3, input: { transcriptId: 't', start: 0, end: 1 }, executions: [], integrity: { status: 'complete' }, result: { status: 'failed', error: { code: 'FILE_ACCESS', message } } } };
    assert.ok(projectSubmission({ submission, answerAvailability: 'unconfirmed' }).submissionNotice.message.includes(message));
    const answered = { ...submission, remote: { ...submission.remote, answer: { transcriptId: 't', index: 1 } } };
    assert.equal(projectSubmission({ submission: answered, answerAvailability: 'available' }).submissionNotice, undefined);
    const internal = { ...submission, remote: { ...submission.remote, result: { status: 'failed', error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } } } };
    assert.doesNotMatch(projectSubmission({ submission: internal, answerAvailability: 'unconfirmed' }).submissionNotice.message, /private diagnostic/);
  }
});
