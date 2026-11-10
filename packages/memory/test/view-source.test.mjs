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

test('memory reads cannot adopt a new version supplied by a reentrant key getter', () => {
  const transcript = new Transcript([{ role: 'user', content: 'memory evidence' }]);
  const memories = new Memories(transcript);
  const content = (value) => ({ topic: 'topic', content: value, sourceIndexes: [0] });
  const [memory] = memories.apply([{ action: 'create', memoryId: null, change: 'initial', sourceIndexes: [0], result: content('original') }]);
  const source = new MemoryViewSource(memories);
  const expected = { ...source.index().stamp };
  const initial = expected.version;
  let reads = 0;
  const keys = keyWithGetter(() => {
    reads++;
    memories.apply([{ action: 'update', memoryId: memory.id, change: 'updated', sourceIndexes: [0], result: content('changed during key access') }]);
    expected.version = String(memories.sequence);
    return memory.id;
  });

  assert.throws(() => source.read(keys, expected), changed);
  assert.equal(reads, 1);
  assert.notEqual(expected.version, initial);
  assert.equal(memories.get(memory.id).content, 'changed during key access');
  const current = source.index();
  const snapshot = source.read([memory.id], current.stamp);
  assert.equal(snapshot.entries[0].value.content, 'changed during key access');
  assert.ok(Object.isFrozen(snapshot.entries[0].value));
});

test('memory inspection does not enumerate the collection and enforces its fixed key scope', () => {
  const transcript = new Transcript([{ role: 'user', content: 'memory evidence' }]);
  const memories = new Memories(transcript);
  const changes = ['first', 'second'].map((topic) => ({ action: 'create', memoryId: null, change: 'initial', sourceIndexes: [0], result: { topic, content: topic, sourceIndexes: [0] } }));
  const [first, second] = memories.apply(changes);
  const source = new MemoryViewSource(memories);
  const scoped = new MemoryViewSource(memories, [second.id]);
  const get = memories.get.bind(memories);
  const reads = [];
  memories.get = (key) => {
    reads.push(key);
    return get(key);
  };
  memories.values = () => assert.fail('inspection must not enumerate all memories');

  const empty = source.inspect([]);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(reads, []);
  const inspected = source.inspect([second.id, first.id]);
  assert.deepEqual(reads, [second.id, first.id]);
  assert.deepEqual(inspected.entries, [
    { key: second.id, summary: { topic: 'second' } },
    { key: first.id, summary: { topic: 'first' } },
  ]);
  assert.deepEqual(inspected.stamp, empty.stamp);
  assert.ok(Object.isFrozen(inspected.entries[0].summary));
  assert.throws(() => source.inspect([first.id, first.id]), TypeError);
  assert.throws(() => source.inspect(['']), TypeError);
  assert.throws(() => source.inspect([0]), TypeError);
  assert.throws(() => source.inspect(['missing']), RangeError);
  assert.throws(() => scoped.inspect([first.id]), RangeError);
  assert.deepEqual(scoped.inspect([second.id]).entries, [{ key: second.id, summary: { topic: 'second' } }]);
});
