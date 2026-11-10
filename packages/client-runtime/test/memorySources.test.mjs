import test from 'node:test';

import assert from 'node:assert/strict';

import { ObservationReplica } from '@capix/client-runtime';

import { baseline } from './fixtures.mjs';

const source = { id: 'saved-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'summary.md', bytes: 12, digest: 'a'.repeat(64) } };

const content = { topic: '文档', content: '已创建 summary.md。', sourceIndexes: [0, 1], sourceResults: [source] };

const record = { id: 'memory-record', memoryId: 'memory', memoriesId: 'fixture-memories', sequence: 1, value: { action: 'create', change: '保存完成', sourceIndexes: [1], sourceResults: [source], result: content } };

const item = { id: 'memory', topic: content.topic, content: content.content, sources: content.sourceIndexes.map((index) => ({ transcriptId: 'fixture-transcript', index })), sourceResults: [source], records: [record] };

const event = { type: 'memory', memoriesId: 'fixture-memories', sequence: 1, occurredAt: '2026-10-11T00:00:00Z', change: { action: 'create', memoryId: 'memory', explanation: '保存完成', sourceIndexes: [1], sourceResults: [source], result: content } };

test('memory replica preserves accepted result sources independently of optional records', () => {
  const first = baseline();
  const delta = { type: 'delta', scopeId: first.scopeId, sequence: 1, changes: [event] };
  const received = [first, delta];
  const initial = ObservationReplica.receive(undefined, received[0]);
  const created = ObservationReplica.receive(initial, received[1]);
  assert.deepEqual(created.memory.items, [{ ...item, records: [] }]);
  assert.deepEqual(initial.memory.items, []);
  const loaded = ObservationReplica.receive(undefined, baseline({ memory: { items: [item] }, memories: { id: first.memories.id, sequence: 1 } }));
  assert.deepEqual(loaded.memory.items[0].sourceResults, [source]);
  const update = { ...event, sequence: 2, change: { ...event.change, action: 'update', result: { ...content, sourceResults: undefined } } };
  const changed = ObservationReplica.receive(loaded, { ...delta, changes: [update] });
  assert.equal(changed.memory.items[0].sourceResults, undefined, 'a replacement uses its complete source set rather than retaining stale local sources');
  assert.deepEqual(changed.memory.items[0].records, [record]);
  assert.deepEqual(loaded.memory.items[0].sourceResults, [source], 'prior replica remains unchanged');
});
