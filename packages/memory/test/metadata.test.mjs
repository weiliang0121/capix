import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories } from '@weiliang0121/capix-memory';
import { create, update, fixed } from './support.mjs';

test('topic and source rules belong to optional business metadata and can be removed', () => {
  const memories = new Memories();
  const metadata = { topic: 'preference', sourceIndexes: [99], sourceResults: [{ kind: 'anything', receipt: { id: 'external' } }] };
  const first = memories.apply([create('summary', metadata)]).changed[0];
  metadata.sourceIndexes.push(100);
  assert.deepEqual(first.value.metadata.sourceIndexes, [99]);
  memories.apply([update(first.id, 'replacement')]);
  assert.equal('metadata' in memories.read(first.id).value, false);
  assert.deepEqual(first.value.metadata.sourceIndexes, [99]);
  for (const value of [
    { content: 'text', topic: 'reserved' },
    { content: 'text', sourceIndexes: [0] },
  ])
    assert.throws(() => memories.apply([{ action: 'create', value }]));
});

test('complete stable content equality preserves undefined, negative zero and record prototypes', () => {
  const memories = new Memories();
  const id = memories.apply([create('summary')]).changed[0].id;
  const set = (metadata, present = true) => memories.apply([{ action: 'update', memoryId: id, value: { content: 'summary', ...(present ? { metadata } : {}) } }]);
  assert.equal(set(undefined).changed.length, 1);
  assert.equal(set(undefined).changed.length, 0);
  assert.equal(set({ a: undefined }).changed.length, 1);
  assert.equal(set({}).changed.length, 1);
  assert.equal(set({ x: -0 }).changed.length, 1);
  assert.equal(set({ x: 0 }).changed.length, 1);
  assert.equal(set({ b: 2, a: 1 }).changed.length, 1);
  assert.equal(set({ a: 1, b: 2 }).changed.length, 0, 'key insertion order is not new content');
  const plain = { a: 1, b: 2 };
  assert.equal(set(Object.assign(Object.create(null), plain)).changed.length, 1);
  assert.equal(set(plain).changed.length, 1);
  const request = fixed(memories, [{ action: 'update', memoryId: id, value: { content: 'summary', metadata: undefined } }]);
  memories.applyFixed(request);
  assert.throws(
    () => memories.confirmFixed({ ...request, command: { ...request.command, changes: [{ action: 'update', memoryId: id, value: { content: 'summary' } }] } }),
    (error) => error.code === 'MEMORY_APPLY_CONFLICT',
  );
});
