import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '@capix/contracts';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { Memories, MemoryViewSource } from '@capix/memory';

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
