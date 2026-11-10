import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Transcript } from '@weiliang0121/capix-transcript';

import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';

const changed = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

function keyWithGetter(read) {
  const keys = [];
  Object.defineProperty(keys, '0', { enumerable: true, get: read });
  keys.length = 1;
  return keys;
}

test('inspection cannot use a new source version introduced by reading requested keys', () => {
  const transcript = new Transcript([{ role: 'user', content: 'original' }]);
  const memories = new Memories(transcript);
  const [memory] = memories.apply([{ action: 'create', memoryId: null, change: 'initial', sourceIndexes: [0], result: { topic: 'old', content: 'original', sourceIndexes: [0] } }]);
  const source = new MemoryViewSource(memories);
  const memoryKeys = keyWithGetter(() => {
    memories.apply([{ action: 'update', memoryId: memory.id, change: 'updated', sourceIndexes: [0], result: { topic: 'new', content: 'changed', sourceIndexes: [0] } }]);
    return memory.id;
  });
  assert.throws(() => source.inspect(memoryKeys), changed);
  assert.equal(source.inspect([memory.id]).entries[0].summary.topic, 'new', 'a new inspection obtains the new source version');
});
