import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

const conflict = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';

test('Memory source preserves fixed scope and returns values independently of later updates', () => {
  const memories = new Memories();
  const createMemory = (content) => ({ action: 'create', value: { content } });
  const [memory] = memories.apply([createMemory('An earlier understanding')]).changed;
  const source = new MemoryViewSource(memories, [memory.id]);
  const directory = source.index();
  const snapshot = source.read([memory.id], directory.stamp);
  assert.equal(typeof snapshot.entries[0].value.snapshot, 'undefined');
  assert.equal(snapshot.entries[0].value.value.content, memory.value.content);
  memories.apply([{ ...createMemory('updated'), action: 'update', memoryId: memory.id }]);
  assert.equal(source.check(directory.stamp), false);
  assert.throws(() => source.read([memory.id], directory.stamp), conflict);
  assert.equal(snapshot.entries[0].value.value.content, 'An earlier understanding');
});
