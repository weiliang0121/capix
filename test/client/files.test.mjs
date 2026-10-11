import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientSubmission, SubmissionContractError } from '@capix/client-runtime';
import { ConversationHttpTransport, HttpTransportError } from '@capix/client-http';
import { client, transport, deferred, submissionSnapshot } from './fixtures.mjs';

const task = () => ({ sourcePath: 'notes/source.md', output: { path: 'results/summary.md' } });
const input = () => ({ messages: [{ role: 'user', content: '总结文件' }], fileTask: task() });
const receipt = () => ({ path: 'results/summary.md', bytes: 20, digest: 'a'.repeat(64) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fileSnapshot = (id, patch = {}) => submissionSnapshot(id, { input: { transcriptId: 'fixture-transcript', start: 0, end: 1 }, task: { kind: 'file', task: task() }, ...patch });

test('local file request is detached, deeply frozen and validates only a relative portable path', () => {
  const request = input();
  const submission = new ClientSubmission(request);
  request.fileTask.sourcePath = 'changed.md';
  request.fileTask.output.path = 'changed-output.md';
  assert.deepEqual(submission.input.fileTask, task());
  assert.deepEqual(submission.snapshot.fileTask, task());
  assert.ok(Object.isFrozen(submission.input.fileTask));
  assert.ok(Object.isFrozen(submission.input.fileTask.output));
  for (const path of ['', '../secret', '/absolute', 'a/../secret', 'a//b', 'C:private', 'a\\b', 'a\u0000b', 'a/'.repeat(600)]) {
    assert.throws(() => new ClientSubmission({ ...input(), fileTask: { sourcePath: path } }), /相对文件路径/);
    assert.throws(() => new ClientSubmission({ ...input(), fileTask: { sourcePath: 'valid.md', output: { path } } }), /相对路径/);
  }
  assert.throws(() => new ClientSubmission({ ...input(), fileTask: { sourcePath: 'a.md', upload: 'body' } }), /文件任务/);
  assert.throws(() => new ClientSubmission({ ...input(), fileTask: { sourcePath: 'a.md', output: { path: 'a.md' } } }), /不能覆盖来源/);
  const outputOnly = new ClientSubmission({ ...input(), fileTask: { output: { path: 'poem.md' } } });
  assert.deepEqual(outputOnly.input.fileTask, { output: { path: 'poem.md' } });
  assert.ok(Object.isFrozen(outputOnly.input.fileTask.output));
  assert.throws(() => new ClientSubmission({ ...input(), fileTask: {} }), /文件任务/);
});

test('queued metadata stays with the original request and dispatches once after failure', async () => {
  const gate = deferred();
  const sent = [];
  const io = transport({
    submit: async (request, receive) => {
      sent.push(request);
      const delivery = io.delivery(request, receive);
      delivery.input();
      if (sent.length === 1) {
        await gate.promise;
        delivery.fail();
      } else delivery.complete();
    },
  });
  const runtime = client({ conversation: io });
  await runtime.initialize();
  runtime.enqueue({ messages: [{ role: 'user', content: '先回答' }] });
  await tick();
  const request = input();
  runtime.enqueue(request);
  request.fileTask.output.path = 'mutated.md';
  await tick();
  assert.deepEqual(runtime.getSnapshot().queue.waiting[0].fileTask, task());
  gate.resolve();
  await tick();
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].input.fileTask, task());
  runtime.stopTranscript();
});

test('confirmed file creation survives overall cancellation and cannot regress or change identity', () => {
  const submission = new ClientSubmission(input());
  const first = fileSnapshot(submission.id, { fileOutput: { status: 'pending', path: task().output.path } });
  submission.receive(first);
  const created = { ...first, revision: 1, fileOutput: { status: 'created', receipt: receipt() } };
  submission.receive(created);
  created.fileOutput.receipt.bytes = 999;
  assert.equal(submission.snapshot.remote.fileOutput.receipt.bytes, 20);
  assert.ok(Object.isFrozen(submission.snapshot.remote.fileOutput.receipt));
  const cancelled = { ...first, revision: 2, fileOutput: { status: 'created', receipt: receipt() }, cancelRequested: true, result: { status: 'cancelled' } };
  submission.receive(cancelled);
  assert.equal(submission.snapshot.remote.fileOutput.status, 'created');
  for (const fileOutput of [undefined, { status: 'pending', path: task().output.path }, { status: 'unconfirmed', path: task().output.path }, { status: 'created', receipt: { ...receipt(), path: 'other.md' } }]) {
    assert.throws(() => submission.receive({ ...cancelled, revision: 3, fileOutput }), SubmissionContractError);
  }
});

test('follow may first reveal a settled receipt; missing file fact is never treated as no creation', () => {
  const submission = new ClientSubmission(input());
  submission.receive(submissionSnapshot(submission.id));
  assert.equal(submission.snapshot.remote.fileOutput, undefined);
  submission.receive(fileSnapshot(submission.id, { revision: 20, fileOutput: { status: 'created', receipt: receipt() }, result: { status: 'failed', error: { code: 'AFTER_COMMIT', message: 'Later failure' } } }));
  assert.equal(submission.snapshot.remote.fileOutput.status, 'created');
  const ordinary = new ClientSubmission({ messages: input().messages });
  assert.throws(() => ordinary.receive(submissionSnapshot(ordinary.id, { fileOutput: { status: 'created', receipt: receipt() } })), SubmissionContractError);
});

test('uncertain publication is not repaired from invented definite later facts', () => {
  const submission = new ClientSubmission(input());
  const snapshot = fileSnapshot(submission.id, { fileOutput: { status: 'unconfirmed', path: task().output.path } });
  submission.receive(snapshot);
  assert.throws(() => submission.receive({ ...snapshot, revision: 1, fileOutput: { status: 'not-created', path: task().output.path, reason: 'failed' } }), SubmissionContractError);
});

test('HTTP preserves file configuration and cumulative receipt and rejects malformed receipts', async () => {
  const config = { configured: true, model: 'fixture', contextBudget: 32768, maxOutputTokens: 1000, timeoutMs: 1000, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } };
  const configuration = new ConversationHttpTransport('', async () => Response.json(config));
  assert.deepEqual((await configuration.config()).files, config.files);
  const snapshot = fileSnapshot('file-submission', { fileOutput: { status: 'created', receipt: receipt() } });
  const io = new ConversationHttpTransport('', async () => Response.json(snapshot));
  assert.deepEqual((await io.read('file-submission')).fileOutput, snapshot.fileOutput);
  assert.deepEqual((await io.read('file-submission')).task, snapshot.task);
  snapshot.fileOutput.receipt.digest = 'invalid';
  await assert.rejects(io.read('file-submission'), (error) => error instanceof HttpTransportError && error.kind === 'contract');
});

test('natural-language submission accepts selected output-only task and settled receipt from first follow', () => {
  const submission = new ClientSubmission({ messages: [{ role: 'user', content: '摘录李白的诗并保存为 results/summary.md' }] });
  const selected = { kind: 'file', task: { output: { path: receipt().path } } };
  submission.receive(fileSnapshot(submission.id, { revision: 12, task: selected, fileOutput: { status: 'created', receipt: receipt() }, answer: { transcriptId: 'fixture-transcript', index: 1 }, result: { status: 'completed' } }));
  selected.task.output.path = 'mutated.md';
  assert.deepEqual(submission.snapshot.remote.task, { kind: 'file', task: { output: { path: receipt().path } } });
  assert.equal(submission.snapshot.remote.fileOutput.status, 'created');
  assert.ok(Object.isFrozen(submission.snapshot.remote.task));
  assert.ok(Object.isFrozen(submission.snapshot.remote.task.task.output));
  assert.equal(submission.snapshot.fileTask, undefined, 'local intent and selected remote task remain distinct');
});

test('task selection is immutable and does not itself imply output or terminal state', () => {
  const submission = new ClientSubmission({ messages: input().messages });
  const selected = fileSnapshot(submission.id);
  submission.receive(selected);
  assert.equal(submission.snapshot.remote.result, undefined);
  assert.equal(submission.snapshot.remote.fileOutput, undefined);
  for (const task of [undefined, { kind: 'reply' }, { kind: 'file', task: { sourcePath: 'other.md' } }, { kind: 'file', task: { sourcePath: 'notes/source.md', output: { path: 'other.md' } } }]) {
    assert.throws(() => submission.receive({ ...selected, revision: 1, task }), SubmissionContractError);
  }
  assert.deepEqual(submission.snapshot.remote, selected, 'rejected transition does not partially change facts');
});

test('explicit file intent cannot be silently ignored, expanded or replaced by service selection', () => {
  for (const selected of [{ kind: 'reply' }, { kind: 'file', task: { sourcePath: 'other.md', output: task().output } }, { kind: 'file', task: { sourcePath: task().sourcePath } }, { kind: 'file', task: { output: task().output } }]) {
    const submission = new ClientSubmission(input());
    assert.throws(() => submission.receive(fileSnapshot(submission.id, { task: selected })), SubmissionContractError);
  }
  const readOnly = new ClientSubmission({ messages: input().messages, fileTask: { sourcePath: task().sourcePath } });
  assert.throws(() => readOnly.receive(fileSnapshot(readOnly.id)), SubmissionContractError, 'service cannot add writing to a read-only task');
  const createOnly = new ClientSubmission({ messages: input().messages, fileTask: { output: task().output } });
  assert.throws(() => createOnly.receive(fileSnapshot(createOnly.id)), SubmissionContractError, 'service cannot add reading to a create-only task');
  for (const kind of ['clarify', 'unsupported']) {
    const submission = new ClientSubmission(input());
    submission.receive(fileSnapshot(submission.id, { task: { kind } }));
    assert.deepEqual(submission.snapshot.remote.task, { kind });
    assert.throws(() => submission.receive(fileSnapshot(submission.id, { revision: 1, task: { kind }, fileOutput: { status: 'created', receipt: receipt() } })), SubmissionContractError);
  }
});

test('selected tasks require accepted input and rejected admission cannot contain task facts', () => {
  const submission = new ClientSubmission({ messages: input().messages });
  assert.throws(() => submission.receive(submissionSnapshot(submission.id, { task: { kind: 'reply' } })), SubmissionContractError);
  assert.throws(() => submission.receive(fileSnapshot(submission.id, { result: { status: 'rejected', error: { code: 'BUSY', message: 'busy' } } })), SubmissionContractError);
  assert.throws(() => submission.receive(fileSnapshot(submission.id, { task: { kind: 'file', task: {} } })), SubmissionContractError);
  assert.throws(() => submission.receive(fileSnapshot(submission.id, { task: { kind: 'file', task: { sourcePath: '../outside.md' } } })), SubmissionContractError);
});

test('HTTP accepts selected output-only task and rejects incomplete task shapes', async () => {
  let selected = { kind: 'file', task: { output: { path: 'poem.md' } } };
  const io = new ConversationHttpTransport('', async () => Response.json(fileSnapshot('selected-task', { task: selected })));
  assert.deepEqual((await io.read('selected-task')).task, selected);
  for (const value of [{ kind: 'file', task: {} }, { kind: 'file', task: { sourcePath: '' } }, { kind: 'file' }, { kind: 'arbitrary' }]) {
    selected = value;
    await assert.rejects(io.read('selected-task'), (error) => error instanceof HttpTransportError && error.kind === 'contract');
  }
});

test('accepted file receipts expose only declared immutable fields from a custom transport', () => {
  const submission = new ClientSubmission(input());
  const fileOutput = { status: 'created', receipt: { ...receipt(), privateBody: 'private document' }, internal: { sensitive: true } };
  submission.receive(fileSnapshot(submission.id, { fileOutput }));
  assert.deepEqual(submission.snapshot.remote.fileOutput, { status: 'created', receipt: receipt() });
  submission.receive(fileSnapshot(submission.id, { fileOutput }));
  assert.equal('internal' in submission.snapshot.remote.fileOutput, false);
});

test('terminal submission cannot retain pending output and rejected submission cannot contain file work', () => {
  for (const status of ['completed', 'cancelled', 'failed']) {
    const submission = new ClientSubmission(input());
    const result = status === 'failed' ? { status, error: { code: 'TEST', message: 'failure' } } : { status };
    assert.throws(() => submission.receive(fileSnapshot(submission.id, { fileOutput: { status: 'pending', path: task().output.path }, result, ...(status === 'cancelled' ? { cancelRequested: true } : {}) })), SubmissionContractError);
    assert.equal(submission.snapshot.remote, undefined, 'invalid terminal facts do not partially commit');
  }
  for (const retry of [undefined, 'admission']) {
    for (const fileOutput of [
      { status: 'created', receipt: receipt() },
      { status: 'not-created', path: task().output.path, reason: 'not-started' },
      { status: 'unconfirmed', path: task().output.path },
    ]) {
      const submission = new ClientSubmission(input());
      assert.throws(() => submission.receive(fileSnapshot(submission.id, { fileOutput, result: { status: 'rejected', error: { code: 'RUNTIME_BUSY', message: 'busy' }, ...(retry ? { retry } : {}) } })), SubmissionContractError);
      assert.equal(submission.snapshot.remote, undefined, 'a file fact cannot authorize re-POST as a rejected submission');
    }
  }
});
