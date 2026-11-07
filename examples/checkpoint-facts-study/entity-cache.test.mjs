import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { Memories, MemoryViewSource } from '@capix/memory';
import { View } from '@capix/view';
import { StableValues } from './stable.mjs';
import { TranscriptSnapshots, MemorySnapshots, ViewSnapshots, measureGrowingPrefixes } from './entity-cache.mjs';

function change(memoryId, content) {
  return { action: memoryId === null ? 'create' : 'update', memoryId, change: 'study update', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } };
}

function counted(source) {
  const calls = { inspect: 0, inspectKeys: 0, read: 0, readKeys: 0, check: 0 };
  let blocked = false;
  return {
    calls,
    block(value) {
      blocked = value;
    },
    source: {
      index: () => source.index(),
      inspect(keys) {
        if (blocked) throw new Error('Source temporarily unavailable');
        calls.inspect++;
        calls.inspectKeys += keys.length;
        return source.inspect(keys);
      },
      read(keys, expected) {
        calls.read++;
        calls.readKeys += keys.length;
        return source.read(keys, expected);
      },
      check(expected) {
        calls.check++;
        return source.check(expected);
      },
    },
  };
}

function fixture() {
  const transcript = new Transcript([{ role: 'user', content: 'original message' }]);
  const memories = new Memories(transcript);
  const [memory] = memories.apply([change(null, 'memory v1')]);
  const messages = counted(new TranscriptViewSource(transcript));
  const notes = counted(new MemoryViewSource(memories));
  const sources = { messages: messages.source, notes: notes.source };
  const view = new View({
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, notes: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'messages', key: 0 },
      { source: 'notes', key: memory.id },
    ],
  });
  return { transcript, memories, memory, messages, notes, sources, view };
}

test('known immutable Memory content is fixed once per version, with stable old deliveries after update', () => {
  const { memories, memory } = fixture();
  const values = new StableValues();
  const snapshots = new MemorySnapshots(memory, values);
  const raw = memory.snapshot();
  const first = snapshots.read();
  assert.notEqual(first, raw, 'the entity original has not acquired a public stable-value certificate');
  const visits = values.visits;
  assert.equal(snapshots.read(), first);
  assert.equal(values.visits, visits);
  memories.apply([change(memory.id, 'memory v2')]);
  const second = snapshots.read();
  assert.notEqual(second, first);
  assert.equal(first.content, 'memory v1');
  assert.equal(raw.content, 'memory v1');
  assert.equal(second.content, 'memory v2');
  assert.equal(snapshots.read(), second);
  assert.equal(snapshots.fixedVersions, 2);
  assert.equal(snapshots.hits, 2);
  assert.throws(() => {
    first.content = 'illegal';
  }, TypeError);
});

test('external frozen snapshots are not implicitly trusted merely because their reference repeats', () => {
  const { memory } = fixture();
  const values = new StableValues();
  const original = memory.snapshot();
  values.own(original);
  const visits = values.visits;
  values.own(original);
  assert.equal(values.visits, visits * 2, 'only the fixed copy receives evidence; the raw origin still incurs validation');
  const snapshots = new MemorySnapshots(memory, values);
  const stable = snapshots.read();
  const after = values.visits;
  assert.equal(snapshots.read(), stable);
  assert.equal(values.visits, after);
});

test('Transcript exact prefix cache includes end, preserves old prefixes after append, and is local to one entity', () => {
  const transcript = new Transcript([{ role: 'user', content: 'one' }]);
  const values = new StableValues();
  const snapshots = new TranscriptSnapshots(transcript, { values });
  const first = snapshots.read(1);
  const visits = values.visits;
  transcript.append({ role: 'assistant', content: 'two' });
  assert.equal(snapshots.read(1), first);
  assert.equal(values.visits, visits, 'an append does not invalidate the already accepted exact prefix');
  const second = snapshots.read(2);
  assert.deepEqual(
    second.map((message) => message.content),
    ['one', 'two'],
  );
  assert.equal(first.length, 1);
  assert.equal(snapshots.read(2), second);
  assert.equal(snapshots.reads, 2);
  assert.equal(snapshots.sourceEntries, 3);
  for (const end of [-1, 0.5, 3, '1', NaN]) assert.throws(() => snapshots.read(end), /Invalid prefix end/);
  const other = new TranscriptSnapshots(new Transcript([{ role: 'user', content: 'different' }]), { values });
  assert.equal(other.read(1)[0].content, 'different');
  assert.notEqual(other.read(1), first);
});

test('prefix cache bounds retained versions without making retained bytes independent of prefix size', () => {
  const transcript = new Transcript([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
  ]);
  const snapshots = new TranscriptSnapshots(transcript, { maxPrefixes: 2 });
  const first = snapshots.read(1);
  snapshots.read(2);
  snapshots.read(3);
  assert.deepEqual(snapshots.retention(), { prefixes: 2, referenceSlots: 5 });
  const reloaded = snapshots.read(1);
  assert.notEqual(reloaded, first, 'an evicted prefix is rebuilt, not retained by a hidden historical map');
  assert.deepEqual(reloaded, first);
  assert.deepEqual(snapshots.retention(), { prefixes: 2, referenceSlots: 4 });
  assert.throws(() => new TranscriptSnapshots(transcript, { maxPrefixes: 0 }));
});

test('a View cache hit avoids old body reads/fixing but still validates the current selected metadata', () => {
  const { view, sources, messages, notes } = fixture();
  const values = new StableValues();
  const snapshots = new ViewSnapshots(view, sources, values);
  const first = snapshots.read();
  const visits = values.visits;
  const inspectKeys = messages.calls.inspectKeys + notes.calls.inspectKeys;
  const readKeys = messages.calls.readKeys + notes.calls.readKeys;
  assert.equal(snapshots.read(), first);
  assert.equal(values.visits, visits);
  assert.equal(messages.calls.readKeys + notes.calls.readKeys, readKeys);
  assert.equal(messages.calls.inspectKeys + notes.calls.inspectKeys, inspectKeys + 2);
  assert.equal(snapshots.indexedEntries, 4);
  assert.equal(snapshots.captures, 1);
  assert.equal(snapshots.hits, 1);
});

test('View membership revision is insufficient: a Memory source update replaces material under identical membership', () => {
  const { view, sources, memories, memory } = fixture();
  const snapshots = new ViewSnapshots(view, sources);
  const first = snapshots.read();
  const membership = view.exportState();
  memories.apply([change(memory.id, 'memory v2')]);
  assert.equal(view.exportState(), membership);
  const second = snapshots.read();
  assert.equal(second.basis.viewRevision, first.basis.viewRevision);
  assert.notEqual(second.basis.sources.notes.version, first.basis.sources.notes.version);
  assert.equal(first.entries.find((entry) => entry.source === 'notes').value.content, 'memory v1');
  assert.equal(second.entries.find((entry) => entry.source === 'notes').value.content, 'memory v2');
  assert.equal(snapshots.captures, 2);
  view.excludeSync([{ source: 'notes', key: memory.id }]);
  const third = snapshots.read();
  assert.notEqual(third.basis.viewRevision, second.basis.viewRevision);
  assert.equal(third.entries.length, 1);
});

test('cached View content does not hide unavailable sources or a different source scope', () => {
  const { view, sources, notes, transcript } = fixture();
  const snapshots = new ViewSnapshots(view, sources);
  const first = snapshots.read();
  notes.block(true);
  assert.throws(() => snapshots.read(), /Source temporarily unavailable/);
  notes.block(false);
  assert.equal(snapshots.read(), first);
  const incompatible = new ViewSnapshots(view, { ...sources, messages: new TranscriptViewSource(transcript, [0]) });
  assert.throws(
    () => incompatible.read(),
    (error) => ['VIEW_CONFLICT', 'VIEW_SOURCE_CONFLICT'].includes(error.code),
  );
});

test('one new full prefix per append still has quadratic cumulative material work despite repeated-read caching', (t) => {
  const rows = [32, 64, 128].map((count) => measureGrowingPrefixes(() => new Transcript(), count));
  for (const row of rows) {
    assert.equal(row.sourceReads, row.count);
    assert.equal(row.cacheHits, row.count);
    assert.equal(row.sourceEntries, (row.count * (row.count + 1)) / 2);
    assert.equal(row.retained.prefixes, 2);
    assert.equal(row.retained.referenceSlots, row.count * 2 - 1);
  }
  assert.ok(rows[2].sourceEntries > rows[1].sourceEntries * 3.9);
  t.diagnostic(JSON.stringify({ growingPrefixes: rows, interpretation: 'sourceEntries counts actual returned full-prefix entries; retained versions are bounded but neither bytes nor append-time full-array work is constant' }));
});
