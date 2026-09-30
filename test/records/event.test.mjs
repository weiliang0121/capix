import { RuntimeRecordHelper } from '@capix-observer/runtime';
import { callFor } from '../fixtures/lifecycle.mjs';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseRecord, ExecutionRecordHelper, EventRecord, EventRecordHelper, RecordBook, InvocationRecordIndex, Clock, Recorder, Runtime, createRuntime } from '@capix-observer/runtime';

import { validateSnapshot } from '@capix-observer/protocol';

class ManualClock extends Clock {
  elapsed = 100;
  wall = '2026-09-23T00:00:00.000Z';
  tick() {
    return this.elapsed;
  }
  now() {
    return this.wall;
  }
}

test('event records share the Book, have their own IDs, and snapshots read the execution index', async () => {
  const book = new RecordBook(),
    clock = new ManualClock();
  const recorder = new Recorder(book, clock);
  const runtime = createRuntime({ recorder: recorder });
  let firstContext, during;
  await invoke(lifecycleFor(runtime).execution({ input: 'first', settings: {} }), (context) => {
    firstContext = context;
    during = ExecutionRecordHelper.observe(runtime.recording, callFor(context));
    clock.elapsed = 125;
    clock.wall = '2026-09-22T23:00:00.000Z';
    return 'done';
  });
  const first = ExecutionRecordHelper.observe(runtime.recording, callFor(firstContext));
  assert.equal(first.events.length, 2);
  assert.notEqual(first.events[0].id, first.events[1].id);
  assert.ok(first.events.every((event) => event.id !== event.callId && event.callId === first.execution.id));
  assert.deepEqual(
    first.events.map((event) => event.offsetMs),
    [0, 25],
  );
  assert.deepEqual(
    first.events.map((event) => event.occurredAt),
    ['2026-09-23T00:00:00.000Z', '2026-09-22T23:00:00.000Z'],
  );
  for (const event of first.events) {
    const record = book.get(event.id);
    assert.ok(record instanceof EventRecord && record instanceof BaseRecord);
    assert.equal(record.value, event.value);
    assert.equal(Object.hasOwn(record, 'contextId'), false);
    assert.equal('status' in record, false);
    assert.throws(() => {
      record.value.type = 'throw';
    }, TypeError);
  }
  const second = lifecycleFor(runtime).execution({ input: 'second', settings: {} }).begin();
  const secondSnapshot = ExecutionRecordHelper.observe(runtime.recording, callFor(second));
  assert.deepEqual(
    secondSnapshot.events.map((event) => event.sequence),
    [1],
  );
  assert.equal(EventRecordHelper.findByExecution(new Recorder(book), first.execution.id).length, 2);
  assert.equal(during.events.length, 1);
  const changed = structuredClone(first);
  changed.events[0].id = changed.events[1].id;
  assert.throws(() => validateSnapshot(changed));
  changed.events[0].id = first.events[0].id;
  changed.events[0].executionId = secondSnapshot.execution.id;
  assert.throws(() => validateSnapshot(changed));
  validateSnapshot(first);
  validateSnapshot(secondSnapshot);
  first.events[0].sequence = 500;
  assert.equal(ExecutionRecordHelper.observe(runtime.recording, callFor(firstContext)).events[0].sequence, 1);
  assert.equal([...book.values()].length, 6); // Two executions and three boundary records.
});

test('event helpers reject foreign/non-call targets and undo an index entry if Book registration fails', () => {
  class FailingBook extends RecordBook {
    reject = false;
    add(record) {
      if (this.reject && record instanceof EventRecord) throw new Error('registration failed');
      return super.add(record);
    }
  }
  const book = new FailingBook(),
    index = new InvocationRecordIndex(book),
    clock = new ManualClock();
  const root = RuntimeRecordHelper.create(new Recorder(book, clock));
  const execution = ExecutionRecordHelper.create(new Recorder(book), index, clock, 'context-one', { input: {}, settings: {} }, root.id);
  const other = ExecutionRecordHelper.create(new Recorder(book), index, clock, 'context-two', { input: {}, settings: {} }, root.id);
  const arbitrary = book.add(new BaseRecord({ anything: true }));
  for (const target of [other.id, arbitrary.id, 'missing']) {
    assert.throws(() => EventRecordHelper.create(new Recorder(book), index, clock, 100, execution.id, target, 'call'), /not an invocation/);
  }
  assert.throws(() => EventRecordHelper.create(new Recorder(book), index, clock, 100, execution.id, execution.id, 'return'), /state/);
  assert.throws(() => EventRecordHelper.create(new Recorder(book), index, clock, 101, execution.id, execution.id, 'call'), /event time/);
  book.reject = true;
  assert.throws(() => EventRecordHelper.create(new Recorder(book), index, clock, 100, execution.id, execution.id, 'call'), /registration failed/);
  assert.deepEqual(index.eventsOf(execution.id), []);
  assert.equal([...book.values()].length, 4);
});
