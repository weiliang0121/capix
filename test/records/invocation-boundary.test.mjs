import { RuntimeRecordHelper } from '@capix-observer/runtime';
import { callFor } from '../fixtures/lifecycle.mjs';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseRecord, ExecutionRecordHelper, InvocationBoundaryRecord, InvocationBoundaryRecordHelper, RecordBook, Clock, Recorder, Runtime, createRuntime } from '@capix-observer/runtime';

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

test('event records share the Book, have their own IDs, and snapshots read the execution tree', async () => {
  const book = new RecordBook(),
    clock = new ManualClock();
  const recorder = new Recorder(book, { clock });
  const runtime = createRuntime({ recorder });
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
    assert.ok(record instanceof InvocationBoundaryRecord && record instanceof BaseRecord);
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
  assert.equal(InvocationBoundaryRecordHelper.findByExecution(new Recorder(book), first.execution.id).length, 2);
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

test('event helpers reject foreign/non-call targets and leave no event or sequence advance if Book registration fails', () => {
  class FailingBook extends RecordBook {
    reject = false;
    add(record) {
      if (this.reject && record instanceof InvocationBoundaryRecord) throw new Error('registration failed');
      return super.add(record);
    }
  }
  const book = new FailingBook(),
    clock = new ManualClock();
  const recorder = new Recorder(book, { clock });
  const root = RuntimeRecordHelper.create(recorder);
  const execution = ExecutionRecordHelper.create(recorder, { contextId: 'context-one', parentId: root.id }, { input: {}, settings: {} });
  const other = ExecutionRecordHelper.create(recorder, { contextId: 'context-two', parentId: root.id }, { input: {}, settings: {} });
  const arbitrary = book.add(new BaseRecord({ anything: true }));
  for (const target of [other.id, arbitrary.id, 'missing']) {
    assert.throws(() => InvocationBoundaryRecordHelper.create(recorder, { start: 100, executionId: execution.id, callId: target }, 'call'), /not an invocation/);
  }
  assert.throws(() => InvocationBoundaryRecordHelper.create(recorder, { start: 100, executionId: execution.id, callId: execution.id }, 'return'), /state/);
  assert.throws(() => InvocationBoundaryRecordHelper.create(recorder, { start: 101, executionId: execution.id, callId: execution.id }, 'call'), /event time/);
  book.reject = true;
  assert.throws(() => InvocationBoundaryRecordHelper.create(recorder, { start: 100, executionId: execution.id, callId: execution.id }, 'call'), /registration failed/);
  assert.equal(InvocationBoundaryRecordHelper.last(recorder, execution.id), undefined);
  assert.deepEqual(execution.childIds, []);
  assert.equal([...book.values()].length, 4);
  book.reject = false;
  const event = InvocationBoundaryRecordHelper.create(recorder, { start: 100, executionId: execution.id, callId: execution.id }, 'call');
  assert.equal(event.sequence, 1);
  assert.deepEqual(execution.childIds, [event.id]);
});

test('last event follows execution sequence across interleaved children, with failed writes leaving sequence reusable', async (t) => {
  const { OperationRecordHelper, AttemptRecordHelper } = await import('@capix-observer/runtime');
  class FailingBook extends RecordBook {
    reject = false;
    add(record) {
      const added = super.add(record);
      if (this.reject && record instanceof InvocationBoundaryRecord) throw new Error('failed after write');
      return added;
    }
  }
  const book = new FailingBook();
  const clock = new ManualClock();
  const recorder = new Recorder(book, { clock });
  const root = RuntimeRecordHelper.create(recorder);
  const execution = ExecutionRecordHelper.create(recorder, { contextId: 'e', parentId: root.id }, { input: {}, settings: {} });
  const operation = (contextId) => OperationRecordHelper.create(recorder, { executionId: execution.id, contextId, operationInstanceId: 'work', operation: 'test', label: 'Test', source: 'test', caller: 'execution', callee: 'operation' }, {});
  const event = (record, type, elapsed) => {
    clock.elapsed = elapsed;
    return InvocationBoundaryRecordHelper.create(recorder, { start: 100, executionId: execution.id, callId: record.id }, type);
  };
  t.mock.method(book, 'values', () => assert.fail('must not scan all records'));
  assert.equal(InvocationBoundaryRecordHelper.last(recorder, execution.id), undefined);
  event(execution, 'call', 100);
  const first = operation('o1');
  event(first, 'call', 101);
  const attempt = AttemptRecordHelper.create(recorder, { operationId: first.id, contextId: 'a1', name: 'test', label: 'Test', source: 'test', caller: 'operation', callee: 'processing' }, {});
  event(attempt, 'call', 102);
  const second = operation('o2');
  const fourth = event(second, 'call', 103);
  AttemptRecordHelper.complete(recorder, attempt.id, {});
  event(attempt, 'return', 104);
  OperationRecordHelper.complete(recorder, first.id, {});
  const sixth = event(first, 'return', 105);
  assert.equal(recorder.tree.descendants(execution.id).at(-1), fourth);
  assert.equal(InvocationBoundaryRecordHelper.last(recorder, execution.id), sixth);
  OperationRecordHelper.complete(recorder, second.id, {});
  assert.throws(() => event(second, 'return', 104), /event time/);
  assert.equal(InvocationBoundaryRecordHelper.last(recorder, execution.id), sixth);
  const before = second.childIds;
  book.reject = true;
  assert.throws(() => event(second, 'return', 106), /failed after write/);
  assert.equal(second.childIds, before);
  assert.equal(InvocationBoundaryRecordHelper.last(recorder, execution.id), sixth);
  book.reject = false;
  assert.equal(event(second, 'return', 106).sequence, 7);
  ExecutionRecordHelper.complete(recorder, execution.id, {});
  assert.equal(event(execution, 'return', 107).sequence, 8);
  const snapshot = ExecutionRecordHelper.snapshot(recorder, execution.id);
  assert.deepEqual(
    snapshot.events.map((record) => record.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  validateSnapshot(snapshot);
});
