import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

import { bindRecording } from '@weiliang0121/capix-runtime';

import { Recorder, RecordBook, MemoryRecord, observeMemory } from '@weiliang0121/capix-records';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

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
