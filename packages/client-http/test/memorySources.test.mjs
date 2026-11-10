import test from 'node:test';

import assert from 'node:assert/strict';

import { ObservationHttpTransport } from '@capix/client-http';

import { ObservationConnectionError } from '@capix/client-runtime';

import { baseline } from './fixtures.mjs';

const source = { id: 'saved-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'summary.md', bytes: 12, digest: 'a'.repeat(64) } };

const content = { topic: '文档', content: '已创建 summary.md。', sourceIndexes: [0, 1], sourceResults: [source] };

const record = { id: 'memory-record', memoryId: 'memory', memoriesId: 'fixture-memories', sequence: 1, value: { action: 'create', change: '保存完成', sourceIndexes: [1], sourceResults: [source], result: content } };

const item = { id: 'memory', topic: content.topic, content: content.content, sources: content.sourceIndexes.map((index) => ({ transcriptId: 'fixture-transcript', index })), sourceResults: [source], records: [record] };

const event = { type: 'memory', memoriesId: 'fixture-memories', sequence: 1, occurredAt: '2026-10-11T00:00:00Z', change: { action: 'create', memoryId: 'memory', explanation: '保存完成', sourceIndexes: [1], sourceResults: [source], result: content } };

const read = (value) => new ObservationHttpTransport('', async () => Response.json(value)).memory();

test('memory HTTP baseline preserves result sources at current, change and complete-source positions', async () => {
  assert.deepEqual(await read({ items: [item] }), { items: [item] });
  for (const invalid of [
    { ...source, kind: 'file-planned' },
    { ...source, answerIndex: -1 },
    { ...source, receipt: { ...source.receipt, digest: 'invalid' } },
    { ...source, receipt: { ...source.receipt, bytes: 1.2 } },
  ]) {
    await assert.rejects(read({ items: [{ ...item, sourceResults: [invalid] }] }), (error) => error.kind === 'contract');
    await assert.rejects(read({ items: [{ ...item, records: [{ ...record, value: { ...record.value, sourceResults: [invalid] } }] }] }), (error) => error.kind === 'contract');
  }
});

test('memory incremental delivery and replica preserve accepted sources independently of optional records', async () => {
  const first = baseline();
  const delta = { type: 'delta', scopeId: first.scopeId, sequence: 1, changes: [event] };
  const frames = [first, delta];
  const io = new ObservationHttpTransport('', async () => new Response(frames.map((value) => JSON.stringify(value)).join('\n')));
  const received = [];
  await assert.rejects(
    io.observe('fixture-conversation', (value) => received.push(value), new AbortController().signal),
    (error) => error instanceof ObservationConnectionError,
  );
  assert.deepEqual(received, frames);
});
