import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { Memories, MemoryViewSource } from '@weiliang0121/capix-memory';

const changed = (error) => error instanceof RuntimeError && error.code === 'VIEW_SOURCE_CONFLICT';

function keyWithGetter(read) {
  const keys = [];
  Object.defineProperty(keys, '0', { enumerable: true, get: read });
  keys.length = 1;
  return keys;
}

test('transcript reads keep their initial version when a key getter changes both the source and expected stamp', () => {
  const transcript = new Transcript([{ role: 'user', content: 'original' }]);
  const source = new TranscriptViewSource(transcript);
  const expected = { ...source.index().stamp };
  const initial = expected.version;
  let reads = 0;
  const keys = keyWithGetter(() => {
    reads++;
    transcript.append({ role: 'assistant', content: 'appended during key access' });
    expected.version = String(transcript.revision);
    return 0;
  });

  assert.throws(() => source.read(keys, expected), changed);
  assert.equal(reads, 1);
  assert.notEqual(expected.version, initial);
  assert.equal(transcript.length, 2, 'a rejected read does not roll back source facts');
  const current = source.index();
  assert.deepEqual(
    source.read([0, 1], current.stamp).entries.map((entry) => entry.value.content),
    ['original', 'appended during key access'],
  );
});

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

test('transcript inspection reads only requested keys and an empty inspection only checks the version', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
  ]);
  const source = new TranscriptViewSource(transcript);
  const scoped = new TranscriptViewSource(transcript, [1]);
  const get = transcript.get.bind(transcript);
  const reads = [];
  transcript.get = (key) => {
    reads.push(key);
    return get(key);
  };
  Object.defineProperty(transcript, 'length', {
    get() {
      assert.fail('inspection must not enumerate the complete transcript');
    },
  });

  const empty = source.inspect([]);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(reads, []);
  const inspected = source.inspect([2, 0]);
  assert.deepEqual(reads, [2, 0]);
  assert.deepEqual(inspected.entries, [
    { key: 2, summary: { role: 'user' } },
    { key: 0, summary: { role: 'user' } },
  ]);
  assert.deepEqual(inspected.stamp, empty.stamp);
  assert.ok(Object.isFrozen(inspected));
  assert.ok(Object.isFrozen(inspected.entries[0].summary));
  assert.throws(() => source.inspect([0, 0]), TypeError);
  assert.throws(() => source.inspect([-1]), TypeError);
  assert.throws(() => source.inspect(['0']), TypeError);
  assert.throws(() => source.inspect([3]), RangeError);
  assert.throws(() => scoped.inspect([0]), RangeError);
  assert.deepEqual(scoped.inspect([1]).entries, [{ key: 1, summary: { role: 'assistant' } }]);
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

test('inspection cannot use a new source version introduced by reading requested keys', () => {
  const transcript = new Transcript([{ role: 'user', content: 'original' }]);
  const messages = new TranscriptViewSource(transcript);
  const messageKeys = keyWithGetter(() => {
    transcript.append({ role: 'assistant', content: 'appended while inspecting' });
    return 0;
  });
  assert.throws(() => messages.inspect(messageKeys), changed);

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
