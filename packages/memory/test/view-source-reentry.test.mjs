import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';

const changed = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

function keyWithGetter(read) {
  const keys = [];
  Object.defineProperty(keys, '0', { enumerable: true, get: read });
  keys.length = 1;
  return keys;
}

test('inspection cannot use a new source version introduced by reading requested keys', () => {
  const memories = new Memories();
  const [memory] = memories.apply([{ action: 'create', value: { content: 'original' } }]).changed;
  const source = new MemoryViewSource(memories);
  const memoryKeys = keyWithGetter(() => {
    memories.apply([{ action: 'update', memoryId: memory.id, value: { content: 'changed' } }]);
    return memory.id;
  });
  assert.throws(() => source.inspect(memoryKeys), changed);
  assert.equal(source.inspect([memory.id]).stamp.version, String(memories.sequence), 'a new inspection obtains the new source version');
});
