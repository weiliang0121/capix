import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { Transcript, TranscriptViewSource } from '@weiliang0121/capix-transcript';

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
