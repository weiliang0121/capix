import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories } from '@capix/memory';
import { Transcript } from '@capix/transcript';
import { bindRecording } from '@capix/server-runtime';
import { Recorder, RecordBook, MemoryRecord, observeMemory } from '@capix/records';
import { ChangeBuffer } from '@capix/changes';

const source = () => ({ id: 'creation-1', kind: 'file-created', answerIndex: 1, receipt: { path: 'answer.md', bytes: 12, digest: 'a'.repeat(64) } });
const create = (receipt = source()) => ({ action: 'create', memoryId: null, change: '保存结果已接纳', sourceIndexes: [0], sourceResults: [receipt], result: { topic: '文件处理', content: '曾创建 answer.md。', sourceIndexes: [0, 1], sourceResults: [receipt] } });
const transcript = () =>
  new Transcript([
    { role: 'user', content: '保存结果' },
    { role: 'assistant', content: '回答正文' },
  ]);

test('memory result sources survive immutable content, changes and optional records independently', () => {
  for (const recorded of [false, true]) {
    const book = new RecordBook();
    const recording = recorded ? bindRecording(new Recorder(book)) : undefined;
    const changes = new ChangeBuffer();
    const memories = new Memories(transcript(), { changes, observation: recording?.memory });
    const proposed = create();
    const [memory] = memories.apply([proposed]);
    const [event] = changes.take();
    assert.deepEqual(memory.sourceResults, [source()]);
    assert.deepEqual(event.change.sourceResults, memory.sourceResults);
    assert.deepEqual(event.change.result.sourceResults, memory.sourceResults);
    assert.notEqual(memory.sourceResults[0], proposed.sourceResults[0]);
    proposed.sourceResults[0].receipt.path = 'rewritten.md';
    assert.equal(memory.sourceResults[0].receipt.path, 'answer.md');
    assert.equal(event.change.sourceResults[0].receipt.path, 'answer.md');
    for (const value of [memory.sourceResults, memory.sourceResults[0], memory.sourceResults[0].receipt, event.change.sourceResults, event.change.sourceResults[0].receipt]) assert.ok(Object.isFrozen(value));
    const view = observeMemory(memories, book).items[0];
    assert.deepEqual(view.sourceResults, memory.sourceResults);
    const records = [...book.values()].filter((entry) => entry instanceof MemoryRecord);
    assert.equal(records.length, recorded ? 1 : 0);
    if (recorded) {
      assert.deepEqual(records[0].value.sourceResults, memory.sourceResults);
      assert.deepEqual(records[0].value.result.sourceResults, memory.sourceResults);
    }
  }
});

test('invalid result sources reject the complete memory batch before mutation or publication', () => {
  const receipt = source();
  const cases = [
    { ...receipt, id: '' },
    { ...receipt, kind: 'file-planned' },
    { ...receipt, answerIndex: 0 },
    { ...receipt, answerIndex: 99 },
    { ...receipt, answerIndex: 1.5 },
    { ...receipt, receipt: { ...receipt.receipt, path: ' ' } },
    { ...receipt, receipt: { ...receipt.receipt, bytes: -1 } },
    { ...receipt, receipt: { ...receipt.receipt, bytes: 0.5 } },
    { ...receipt, receipt: { ...receipt.receipt, digest: 'bad' } },
  ];
  const changes = new ChangeBuffer();
  const memories = new Memories(transcript(), { changes });
  for (const invalid of cases) assert.throws(() => memories.apply([create(), create(invalid)]));
  const duplicate = create();
  duplicate.result.sourceResults.push(source());
  assert.throws(() => memories.apply([create(), duplicate]), /unique identity/);
  const incomplete = create();
  delete incomplete.result.sourceResults;
  assert.throws(() => memories.apply([create(), incomplete]), /include the unchanged/);
  const altered = create();
  altered.result.sourceResults = [{ ...receipt, receipt: { ...receipt.receipt, bytes: 13 } }];
  assert.throws(() => memories.apply([create(), altered]), /include the unchanged/);
  assert.equal(memories.values().length, 0);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(changes.take(), []);
});

test('updates preserve source identity and compare result sources when checking no-op changes', () => {
  const memories = new Memories(transcript());
  const [memory] = memories.apply([create()]);
  const update = { ...create(), action: 'update', memoryId: memory.id };
  assert.deepEqual(memories.apply([update]), []);
  assert.equal(memories.sequence, 1);
  const altered = source();
  altered.receipt.digest = 'b'.repeat(64);
  assert.throws(() => memories.apply([{ ...update, sourceResults: [altered], result: { ...update.result, sourceResults: [altered] } }]), /identity cannot change/);
  assert.equal(memories.sequence, 1);
  const newer = { ...source(), id: 'creation-2' };
  memories.apply([{ ...update, sourceResults: [newer], result: { ...update.result, sourceResults: [source(), newer] } }]);
  assert.equal(memories.sequence, 2);
  assert.equal(memory.sourceResults.length, 2);
});

test('message-only memories retain their existing shape and empty optional sources do not create changes', () => {
  const memories = new Memories(transcript());
  const change = create();
  delete change.sourceResults;
  delete change.result.sourceResults;
  const [memory] = memories.apply([change]);
  assert.equal('sourceResults' in memory.snapshot(), false);
  assert.deepEqual(memories.apply([{ ...change, action: 'update', memoryId: memory.id, sourceResults: [], result: { ...change.result, sourceResults: [] } }]), []);
  assert.equal(memories.sequence, 1);
});
