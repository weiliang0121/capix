import test from 'node:test';

import assert from 'node:assert/strict';

import { ConversationHttpTransport, HttpTransportError } from '@capix/client-http';

import { submissionSnapshot } from './fixtures.mjs';

const task = () => ({ sourcePath: 'notes/source.md', output: { path: 'results/summary.md' } });

const input = () => ({ messages: [{ role: 'user', content: '总结文件' }], fileTask: task() });

const receipt = () => ({ path: 'results/summary.md', bytes: 20, digest: 'a'.repeat(64) });

const fileSnapshot = (id, patch = {}) => submissionSnapshot(id, { input: { transcriptId: 'fixture-transcript', start: 0, end: 1 }, task: { kind: 'file', task: task() }, ...patch });

test('HTTP preserves file configuration and cumulative receipt and rejects malformed receipts', async () => {
  const config = { configured: true, model: 'fixture', contextBudget: 32768, maxOutputTokens: 1000, timeoutMs: 1000, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } };
  const configuration = new ConversationHttpTransport('', async () => Response.json(config));
  assert.deepEqual((await configuration.config()).files, config.files);
  const snapshot = fileSnapshot('file-submission', { fileOutput: { status: 'created', receipt: receipt() } });
  const io = new ConversationHttpTransport('', async () => Response.json({ type: 'baseline', submission: snapshot }));
  assert.deepEqual((await io.read('file-submission')).submission.fileOutput, snapshot.fileOutput);
  assert.deepEqual((await io.read('file-submission')).submission.task, snapshot.task);
  snapshot.fileOutput.receipt.digest = 'invalid';
  await assert.rejects(io.read('file-submission'), (error) => error instanceof HttpTransportError && error.kind === 'contract');
});

test('HTTP accepts selected output-only task and rejects incomplete task shapes', async () => {
  let selected = { kind: 'file', task: { output: { path: 'poem.md' } } };
  const io = new ConversationHttpTransport('', async () => Response.json({ type: 'baseline', submission: fileSnapshot('selected-task', { task: selected }) }));
  assert.deepEqual((await io.read('selected-task')).submission.task, selected);
  for (const value of [{ kind: 'file', task: {} }, { kind: 'file', task: { sourcePath: '' } }, { kind: 'file' }, { kind: 'arbitrary' }]) {
    selected = value;
    await assert.rejects(io.read('selected-task'), (error) => error instanceof HttpTransportError && error.kind === 'contract');
  }
});
