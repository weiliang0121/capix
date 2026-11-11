import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Memories } from '@weiliang0121/capix-memory';
import { bindRecording } from '@weiliang0121/capix-runtime';
import { Recorder, RecordBook, MemoryRecord, observeMemory } from '@weiliang0121/capix-records';
import { ChangeBuffer } from '@weiliang0121/capix-changes';

test('entity metadata remains fixed while optional records and baseline use the same explicit content projection', () => {
  for (const recorded of [false, true]) {
    const book = new RecordBook();
    const recording = recorded ? bindRecording(new Recorder(book)) : undefined;
    const changes = new ChangeBuffer();
    const memories = new Memories({ changes, observation: recording?.memory });
    const metadata = { topic: 'business-choice', sources: ['document:A'], optional: undefined, weight: -0 };
    const [memory] = memories.apply([{ action: 'create', value: { content: 'A summary', metadata } }]).changed;
    const [event] = changes.take();
    metadata.sources.push('new');
    assert.deepEqual(memory.value.metadata.sources, ['document:A']);
    assert.deepEqual(event.change.value, memory.value);
    assert.ok(Object.isFrozen(event.change.value.metadata));
    const view = observeMemory(memories, book).items[0];
    assert.deepEqual(view.value, { content: 'A summary' });
    const records = [...book.values()].filter((entry) => entry instanceof MemoryRecord);
    assert.equal(records.length, recorded ? 1 : 0);
    if (recorded) assert.deepEqual(records[0].value.result, view.value);
    assert.equal(Object.is(memory.value.metadata.weight, -0), true);
    assert.equal(Object.hasOwn(memory.value.metadata, 'optional'), true);
  }
});
