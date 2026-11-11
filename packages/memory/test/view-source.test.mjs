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

test('memory reads cannot adopt a new version supplied by a reentrant key getter', () => {
  const memories = new Memories();
  const content = (value) => ({ content: value });
  const [memory] = memories.apply([{ action: 'create', value: content('original') }]).changed;
  const source = new MemoryViewSource(memories);
  const expected = { ...source.index().stamp };
  const initial = expected.version;
  let reads = 0;
  const keys = keyWithGetter(() => {
    reads++;
    memories.apply([{ action: 'update', memoryId: memory.id, value: content('changed during key access') }]);
    expected.version = String(memories.sequence);
    return memory.id;
  });

  assert.throws(() => source.read(keys, expected), changed);
  assert.equal(reads, 1);
  assert.notEqual(expected.version, initial);
  assert.equal(memories.read(memory.id).value.content, 'changed during key access');
  const current = source.index();
  const snapshot = source.read([memory.id], current.stamp);
  assert.equal(snapshot.entries[0].value.value.content, 'changed during key access');
  assert.ok(Object.isFrozen(snapshot.entries[0].value));
});

test('memory inspection does not enumerate the collection and enforces its fixed key scope', () => {
  const memories = new Memories();
  const changes = ['first', 'second'].map((content) => ({ action: 'create', value: { content } }));
  const [first, second] = memories.apply(changes).changed;
  const source = new MemoryViewSource(memories);
  const scoped = new MemoryViewSource(memories, [second.id]);
  const get = memories.read.bind(memories);
  const reads = [];
  memories.read = (key) => {
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
    { key: second.id, summary: undefined },
    { key: first.id, summary: undefined },
  ]);
  assert.deepEqual(inspected.stamp, empty.stamp);
  assert.equal(inspected.entries[0].summary, undefined);
  assert.deepEqual(source.read([second.id], inspected.stamp).entries, [{ key: second.id, value: second }]);
  assert.deepEqual(scoped.index().entries, [{ key: second.id, summary: undefined }]);
  assert.deepEqual(scoped.read([second.id], scoped.index().stamp).entries, [{ key: second.id, value: second }]);
  assert.throws(() => scoped.read([first.id], scoped.index().stamp), RangeError);
  assert.throws(() => source.inspect([first.id, first.id]), TypeError);
  assert.throws(() => source.inspect(['']), TypeError);
  assert.throws(() => source.inspect([0]), TypeError);
  assert.throws(() => source.inspect(['missing']), RangeError);
  assert.throws(() => scoped.inspect([first.id]), RangeError);
  assert.deepEqual(scoped.inspect([second.id]).entries, [{ key: second.id, summary: undefined }]);
});
