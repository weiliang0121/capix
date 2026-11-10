import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Transcript } from '@weiliang0121/capix-transcript';

const conflict = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';

test('Memory source preserves fixed scope and returns values independently of later updates', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'Original request' },
    { role: 'assistant', content: 'Original answer' },
  ]);
  const memories = new Memories(transcript);
  const createMemory = (content) => ({ action: 'create', memoryId: null, change: 'initial', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });
  const [memory] = memories.apply([createMemory('An earlier understanding')]);
  const source = new MemoryViewSource(memories, [memory.id]);
  const directory = source.index();
  const snapshot = source.read([memory.id], directory.stamp);
  assert.equal(typeof snapshot.entries[0].value.snapshot, 'undefined');
  assert.equal(snapshot.entries[0].value.content, memory.content);
  memories.apply([{ ...createMemory('updated'), action: 'update', memoryId: memory.id }]);
  assert.equal(source.check(directory.stamp), false);
  assert.throws(() => source.read([memory.id], directory.stamp), conflict);
  assert.equal(snapshot.entries[0].value.content, 'An earlier understanding');
});
