import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationSubmission, ConversationInputError } from '@capix/observer-service';
import { ClientSubmission } from '@capix/client-runtime';

const receipt = Object.freeze({ path: 'answer.md', bytes: 3, digest: 'a'.repeat(64) });
const complete = (submission) =>
  new Promise((resolve) => {
    let disconnect = () => {};
    disconnect = submission.connect((snapshot) => {
      if (snapshot.result) {
        disconnect();
        resolve(snapshot);
      }
    });
    if (submission.snapshot.result) disconnect();
  });
function request(submission) {
  submission.progress.publish({ kind: 'input', range: { transcriptId: 'files-transcript', start: 0, end: 1 } });
  submission.progress.publish({ kind: 'task', task: { kind: 'file', task: { output: { path: receipt.path } } } });
  submission.fileProgress.publish({ kind: 'requested', path: receipt.path });
}

test('accepted file intent prevents a late input-shaped error from being projected as non-admission', async () => {
  const submission = new ConversationSubmission('accepted-file-late-error', 'conversation');
  submission.start(async () => {
    request(submission);
    throw new ConversationInputError('late binding failure');
  });
  const snapshot = await complete(submission);
  assert.equal(snapshot.result.status, 'failed');
  assert.equal(snapshot.fileOutput.status, 'not-created');
});

test('a committed output survives overall failure and later file observer faults', async () => {
  const submission = new ConversationSubmission('saved-then-failed', 'conversation');
  request(submission);
  submission.start(async () => {
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    submission.fileProgress.publish({ kind: 'created', receipt });
    submission.fileProgress.publish({ kind: 'created', receipt });
    throw new Error('postprocessing failed');
  });
  const snapshot = await complete(submission);
  assert.equal(snapshot.result.status, 'failed');
  assert.deepEqual(snapshot.fileOutput, { status: 'created', receipt });
  assert.ok(submission.fileProgress.failure);
  assert.equal(snapshot.integrity.status, 'complete', 'file feedback has its own integrity boundary');
});

test('finishing without reaching creation confirms not-started; an interrupted started output remains unconfirmed', async () => {
  const skipped = new ConversationSubmission('needs-info', 'conversation');
  request(skipped);
  skipped.start(async () => undefined);
  assert.deepEqual((await complete(skipped)).fileOutput, { status: 'not-created', path: receipt.path, reason: 'not-started' });
  const interrupted = new ConversationSubmission('unknown-write', 'conversation');
  request(interrupted);
  interrupted.start(async () => {
    interrupted.fileProgress.publish({ kind: 'started', path: receipt.path });
    throw new Error('missing producer result');
  });
  assert.deepEqual((await complete(interrupted)).fileOutput, { status: 'unconfirmed', path: receipt.path });
});

test('file feedback failure cannot become a false no-write result on finish', async () => {
  const submission = new ConversationSubmission('file-progress-failed', 'conversation');
  request(submission);
  submission.start(async () => {
    submission.fileProgress.publish({ kind: 'started', path: 'wrong.md' });
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    submission.fileProgress.publish({ kind: 'created', receipt });
  });
  const snapshot = await complete(submission);
  assert.equal(snapshot.result.status, 'completed');
  assert.deepEqual(snapshot.fileOutput, { status: 'unconfirmed', path: receipt.path });
  assert.equal(snapshot.integrity.status, 'complete');
});

test('known non-publication keeps its reason; ordinary turns have no file state', async () => {
  const submission = new ConversationSubmission('known-no-file', 'conversation');
  request(submission);
  submission.start(async () => {
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    submission.fileProgress.publish({ kind: 'not-created', path: receipt.path, reason: 'cancelled' });
    throw new Error('call ended');
  });
  assert.deepEqual((await complete(submission)).fileOutput, { status: 'not-created', path: receipt.path, reason: 'cancelled' });
  const plain = new ConversationSubmission('plain', 'conversation');
  plain.start(async () => undefined);
  assert.equal((await complete(plain)).fileOutput, undefined);
});

test('file progress without accepted task never exposes orphaned output facts', () => {
  for (const task of [undefined, { kind: 'reply' }, { kind: 'clarify' }, { kind: 'file', task: { sourcePath: 'notes.md' } }]) {
    const submission = new ConversationSubmission('orphan-file-progress', 'conversation');
    submission.progress.publish({ kind: 'input', range: { transcriptId: 'files-transcript', start: 0, end: 1 } });
    if (task) submission.progress.publish({ kind: 'task', task });
    submission.fileProgress.publish({ kind: 'requested', path: receipt.path });
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    submission.fileProgress.publish({ kind: 'created', receipt });
    assert.equal(submission.snapshot.fileOutput, undefined);
    assert.equal(submission.snapshot.integrity.status, 'incomplete');
    assert.ok(submission.fileProgress.failure);
  }
});

test('failed task progress leaves execution independent and terminal feedback consumable by the client', async () => {
  const client = new ClientSubmission('conversation', { messages: [{ role: 'user', content: '保存为 answer.md' }] });
  const submission = new ConversationSubmission(client.id, 'conversation');
  const received = [];
  const disconnect = submission.connect((snapshot) => {
    received.push(snapshot);
  });
  let writes = 0;
  submission.start(async () => {
    submission.progress.publish({ kind: 'input', range: { transcriptId: 'files-transcript', start: 0, end: 1 } });
    submission.progress.publish({ kind: 'input', range: { transcriptId: 'files-transcript', start: 1, end: 2 } });
    submission.progress.publish({ kind: 'task', task: { kind: 'file', task: { output: { path: receipt.path } } } });
    submission.fileProgress.publish({ kind: 'requested', path: receipt.path });
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    writes += 1;
    submission.fileProgress.publish({ kind: 'created', receipt });
  });
  const snapshot = await complete(submission);
  disconnect();
  assert.equal(writes, 1, 'passive progress failure neither prevents nor repeats work');
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.integrity.status, 'incomplete');
  assert.equal(snapshot.task, undefined);
  assert.equal(snapshot.fileOutput, undefined, 'unknown task cannot lend ownership to a file result');
  for (const value of received) client.receive(value);
  client.receive(snapshot);
  assert.equal(client.snapshot.remote.result.status, 'completed');
  assert.equal(client.snapshot.remote.integrity.status, 'incomplete');
});

test('a mismatched output path cannot start a second output or rewrite a confirmed receipt', async () => {
  const submission = new ConversationSubmission('different-output', 'conversation');
  request(submission);
  submission.start(async () => {
    submission.fileProgress.publish({ kind: 'started', path: receipt.path });
    submission.fileProgress.publish({ kind: 'created', receipt });
    submission.fileProgress.publish({ kind: 'requested', path: 'other.md' });
  });
  const snapshot = await complete(submission);
  assert.deepEqual(snapshot.fileOutput, { status: 'created', receipt });
  assert.equal(snapshot.task.task.output.path, receipt.path);
  assert.equal(snapshot.integrity.status, 'complete');
  assert.ok(submission.fileProgress.failure);
});
