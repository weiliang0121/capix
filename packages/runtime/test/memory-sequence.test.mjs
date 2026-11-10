import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

import { bindRecording } from '@weiliang0121/capix-runtime';

import { Recorder, RecordBook, MemoryRecord, observeMemory } from '@weiliang0121/capix-records';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

const create = (text) => ({ action: 'create', memoryId: null, change: 'create', sourceIndexes: [0], result: { topic: 'topic', content: text, sourceIndexes: [0] } });

const update = (memory, text) => ({ ...create(text), action: 'update', memoryId: memory.id });

const transcript = () => new Transcript([{ role: 'user', content: 'input' }]);

test('Memories sequences actual changes across different memories and preserves scope identity on records', () => {
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const memories = new Memories(transcript(), { observation: recording.memory });
  const [first, second] = memories.apply([create('one'), create('two')]);
  assert.equal(memories.sequence, 2);
  assert.deepEqual(memories.apply([update(first, 'one')]), []);
  assert.equal(memories.sequence, 2);
  assert.throws(() => memories.apply([create('three'), update({ id: 'missing' }, 'bad')]), /does not exist/);
  assert.equal(memories.sequence, 2);
  memories.apply([update(first, 'changed')]);
  const records = [...recorder.book.values()].filter((record) => record instanceof MemoryRecord);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    records.map((record) => record.memoryId),
    [first.id, second.id, first.id],
  );
  assert.ok(records.every((record) => record.memoriesId === memories.id));
  const view = observeMemory(memories, recorder.book);
  assert.deepEqual(
    view.items[0].records.map((record) => record.sequence),
    [1, 3],
  );
  assert.equal(view.items[0].records[0].memoriesId, memories.id);
});

test('recording failure does not reuse a memory change position or undo the applied content', () => {
  class RejectingBook extends RecordBook {
    reject = true;
    add(record) {
      if (this.reject && record instanceof MemoryRecord) throw new Error('record rejected');
      return super.add(record);
    }
  }
  const book = new RejectingBook();
  const faults = [];
  const changes = new ChangeBuffer();
  const recording = bindRecording(new Recorder(book), { failure: 'propagate', invalidate: (error) => faults.push(error) });
  const memories = new Memories(transcript(), { observation: recording.memory, changes });
  assert.throws(
    () => memories.apply([create('one')]),
    (error) => error.code === 'OBSERVATION_FAILED' && error.cause.message === 'record rejected',
  );
  assert.equal(memories.values()[0].content, 'one');
  assert.equal(memories.sequence, 1);
  book.reject = false;
  memories.apply([update(memories.values()[0], 'two')]);
  assert.equal(memories.sequence, 2);
  // The entity keeps producing facts; the failed observation consumer stays disabled.
  assert.deepEqual(
    changes.take().map((event) => event.sequence),
    [1, 2],
  );
  assert.equal([...book.values()].filter((record) => record instanceof MemoryRecord).length, 0);
  assert.equal(faults.length, 1);
});
