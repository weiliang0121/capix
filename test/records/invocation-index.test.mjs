import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock, RecordBook, RuntimeRecorder, InvocationRecordIndex, ExecutionRecordHelper, OperationRecordHelper, AttemptRecordHelper, EventRecordHelper } from '@capix-observer/runtime';

const operationDefinition = (executionId, contextId) => ({ executionId, contextId, operationInstanceId: 'operation', operation: 'echo', label: 'Echo', source: 'test', caller: 'execution', callee: 'operation' });

test('call associations are queryable when registration is published, without scanning Book', (t) => {
  const book = new RecordBook();
  const recorder = new RuntimeRecorder(book);
  const index = new InvocationRecordIndex(book);
  t.mock.method(book, 'values', () => {
    throw new Error('Unexpected Book scan');
  });
  const observed = [];
  recorder.subscribe((record) => {
    observed.push(index.findByContext(record.contextId));
  });
  const execution = ExecutionRecordHelper.create(recorder, index, recorder.clock, 'execution', { input: {}, settings: {} });
  const operation = OperationRecordHelper.create(recorder, index, operationDefinition(execution.id, 'operation'), {});
  const attempt = AttemptRecordHelper.create(recorder, index, { operationId: operation.id, contextId: 'attempt', name: 'echo', label: 'Echo', source: 'test', caller: 'operation', callee: 'processing' }, {});
  assert.deepEqual(observed, [execution, operation, attempt]);
  assert.deepEqual(index.operationsOf(execution.id), [operation]);
  assert.deepEqual(index.attemptsOf(operation.id), [attempt]);
  assert.equal(index.hasExecution(execution.id), true);
  assert.equal(new InvocationRecordIndex(book).hasExecution(execution.id), false);
  assert.equal(index.findByContext('missing'), undefined);
});

test('failed Book registration rolls back every association and duplicate Context preserves the existing record', () => {
  class RejectingBook extends RecordBook {
    reject = false;
    add(record) {
      if (this.reject) throw new Error('Book rejected record');
      return super.add(record);
    }
  }
  const book = new RejectingBook();
  const recorder = new RuntimeRecorder(book);
  const index = new InvocationRecordIndex(book);
  const notifications = [];
  recorder.subscribe((record) => notifications.push(record));
  book.reject = true;
  assert.throws(() => ExecutionRecordHelper.create(recorder, index, recorder.clock, 'execution', { input: {}, settings: {} }), /Book rejected/);
  assert.equal(index.findByContext('execution'), undefined);
  assert.equal(notifications.length, 0);
  book.reject = false;
  const execution = ExecutionRecordHelper.create(recorder, index, recorder.clock, 'execution', { input: {}, settings: {} });
  book.reject = true;
  const definition = operationDefinition(execution.id, 'operation');
  assert.throws(() => OperationRecordHelper.create(recorder, index, definition, {}), /Book rejected/);
  assert.equal(index.findByContext('operation'), undefined);
  assert.deepEqual(index.operationsOf(execution.id), []);
  assert.equal(notifications.length, 1);
  book.reject = false;
  const operation = OperationRecordHelper.create(recorder, index, definition, {});
  assert.throws(() => OperationRecordHelper.create(recorder, index, definition, {}), /Context is already recorded/);
  assert.equal(index.findByContext('operation'), operation);
  assert.deepEqual(index.operationsOf(execution.id), [operation]);
  assert.deepEqual(notifications, [execution, operation]);
});

test('event append keeps sequence and monotonic-time rules outside the association index', () => {
  class ManualClock extends Clock {
    elapsed = 10;
    tick() {
      return this.elapsed;
    }
  }
  const book = new RecordBook();
  const clock = new ManualClock();
  const recorder = new RuntimeRecorder(book, clock);
  const index = new InvocationRecordIndex(book);
  const execution = ExecutionRecordHelper.create(recorder, index, clock, 'execution', { input: {}, settings: {} });
  const first = EventRecordHelper.create(recorder, index, clock, 0, execution.id, execution.id, 'call');
  ExecutionRecordHelper.complete(book, index, execution.id, {});
  clock.elapsed = 9;
  assert.throws(() => EventRecordHelper.create(recorder, index, clock, 0, execution.id, execution.id, 'return'), /Invalid event time/);
  assert.equal(index.lastEventOf(execution.id), first);
  clock.elapsed = 10;
  const last = EventRecordHelper.create(recorder, index, clock, 0, execution.id, execution.id, 'return');
  assert.equal(last.sequence, 2);
  assert.equal(last.offsetMs, first.offsetMs);
  assert.deepEqual(index.eventsOf(execution.id), [first, last]);
  assert.equal(index.hasExecution(execution.id), true);
});
