import { createRecordScope } from '../fixtures/runtime.mjs';
import { RuntimeRecordHelper } from '@capix-observer/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordBook, Recorder, BaseRecord, ExecutionRecord, OperationRecord, AttemptRecord, InvocationBoundaryRecord, MemoryRecord, TranscriptRecord, ExecutionRecordHelper, OperationRecordHelper, AttemptRecordHelper } from '@capix-observer/runtime';

const operationDefinition = (executionId, contextId, parentOperationId) => ({ executionId, contextId, parentOperationId, operationInstanceId: 'instance', operation: 'test', label: 'Test', source: 'test', caller: 'execution', callee: 'operation' });
const attemptDefinition = (operationId) => ({ operationId, contextId: 'attempt', name: 'apply', label: 'Apply', source: 'test', caller: 'operation', callee: 'processing' });
const memoryValue = { action: 'create', change: '新增约束', sourceIndexes: [0], result: { topic: '偏好', content: '步行', sourceIndexes: [0] } };
function fixture(book = new RecordBook()) {
  const recorder = new Recorder(book);
  const root = createRecordScope(recorder);
  const execution = ExecutionRecordHelper.create(recorder, { contextId: 'execution', parentId: root.id }, { input: {}, settings: {} });
  return { recorder, root, execution };
}

test('record tree retains direct ownership, immutable child snapshots and content subjects without scanning Book', (t) => {
  const { recorder, execution } = fixture();
  const old = execution.toJSON();
  t.mock.method(recorder.book, 'values', () => {
    throw new Error('Unexpected full scan');
  });
  const operation = OperationRecordHelper.create(recorder, operationDefinition(execution.id, 'operation'), {});
  const nested = OperationRecordHelper.create(recorder, operationDefinition(execution.id, 'nested', operation.id), {});
  const attempt = AttemptRecordHelper.create(recorder, attemptDefinition(nested.id), {});
  const event = recorder.add(new InvocationBoundaryRecord({ executionId: execution.id, callId: attempt.id, sequence: 1, occurredAt: recorder.clock.now(), offsetMs: 0 }, { type: 'call' }));
  const memory = recorder.add(new MemoryRecord({ memoryId: 'memory', memoriesId: 'transcript', sequence: 1, source: { executionId: execution.id, operationId: nested.id, contextId: attempt.contextId, callId: attempt.id } }, memoryValue));
  const transcript = recorder.add(new TranscriptRecord({ transcriptId: 'transcript', revision: 1, occurredAt: recorder.clock.now(), source: { contextId: execution.contextId, callId: execution.id, executionId: execution.id } }, { action: 'append', start: 0, messages: [{ role: 'assistant', content: '好' }] }));
  const outside = recorder.add(new TranscriptRecord({ transcriptId: 'transcript', revision: 1, occurredAt: recorder.clock.now() }, { action: 'segment', previousStart: 0, start: 0, end: 1 }));
  assert.deepEqual(execution.childIds, [operation.id, transcript.id]);
  assert.deepEqual(operation.childIds, [nested.id]);
  assert.deepEqual(attempt.childIds, [event.id, memory.id]);
  assert.deepEqual(old.childIds, []);
  assert.throws(() => execution.childIds.push('fake'), TypeError);
  assert.equal(memory.parentId, attempt.id);
  assert.equal(memory.toJSON().parentId, attempt.id);
  assert.equal(memory.memoryId, 'memory');
  assert.equal(outside.parentId, undefined);
  assert.deepEqual(recorder.tree.children(execution.id), [operation, transcript]);
  assert.deepEqual(recorder.tree.descendants(execution.id), [operation, nested, attempt, event, memory, transcript]);
  assert.deepEqual(recorder.tree.children(memory.id), []);
  assert.throws(() => recorder.tree.children('missing'), /does not exist/);
});

test('registration publishes once, with the changed parent and all lookups already coherent', () => {
  const { recorder, execution } = fixture();
  const observed = [];
  recorder.subscribe((record, change, related) => {
    observed.push({ record, change, related, children: recorder.tree.children(execution.id), stored: recorder.book.get(record.id) });
  });
  const operation = OperationRecordHelper.create(recorder, operationDefinition(execution.id, 'operation'), {});
  assert.deepEqual(observed, [{ record: operation, change: 'add', related: [execution], children: [operation], stored: operation }]);
});

test('registration rejects dangling and wrong parents even when helpers are not used', () => {
  const { recorder, execution } = fixture();
  const operation = recorder.add(new OperationRecord(operationDefinition(execution.id, 'operation'), {}));
  const leaf = recorder.add(new BaseRecord({}));
  const other = recorder.add(new ExecutionRecord('other', { input: {}, settings: {}, startedAt: recorder.clock.now() }, execution.parentId));
  assert.throws(() => recorder.add(new AttemptRecord(attemptDefinition(execution.id), {})), /operation parent/);
  assert.throws(() => recorder.add(new BaseRecord({}, 'missing')), /does not exist/);
  assert.throws(() => recorder.add(new BaseRecord({}, leaf.id)), /cannot contain/);
  assert.throws(() => recorder.add(new OperationRecord(operationDefinition(other.id, 'bad', operation.id), {})), /another execution/);
  assert.throws(() => recorder.add(new MemoryRecord({ memoryId: 'm', memoriesId: 'transcript', sequence: 1, source: { executionId: execution.id, operationId: undefined, contextId: 'wrong-context', callId: execution.id } }, memoryValue)), /does not match its call/);
  assert.throws(() => recorder.add(new MemoryRecord({ memoryId: 'm', memoriesId: 'transcript', sequence: 1, source: { executionId: other.id, operationId: undefined, contextId: execution.contextId, callId: execution.id } }, memoryValue)), /another execution/);
  assert.throws(() => recorder.add(new MemoryRecord({ memoryId: 'm', memoriesId: 'transcript', sequence: 1, source: { executionId: execution.id, operationId: undefined, contextId: undefined, callId: undefined } }, memoryValue)), /requires a call parent/);
  assert.throws(() => recorder.add(operation), /already exists/);
  assert.deepEqual(execution.childIds, [operation.id]);
});

test('ended calls accept terminal evidence and sourced content, but cannot start new work', () => {
  const { recorder, execution } = fixture();
  execution.complete({});
  const terminal = recorder.add(new InvocationBoundaryRecord({ executionId: execution.id, callId: execution.id, sequence: 1, occurredAt: recorder.clock.now(), offsetMs: 0 }, { type: 'return' }));
  const content = recorder.add(new MemoryRecord({ memoryId: 'm', memoriesId: 'transcript', sequence: 1, source: { executionId: execution.id, operationId: undefined, contextId: execution.contextId, callId: execution.id } }, memoryValue));
  assert.throws(() => recorder.add(new OperationRecord(operationDefinition(execution.id, 'late'), {})), /already ended/);
  assert.deepEqual(execution.childIds, [terminal.id, content.id]);
});

test('failed registration cleans partial Book writes without publishing or changing childIds', () => {
  class FailingBook extends RecordBook {
    reject = false;
    add(record) {
      const added = super.add(record);
      if (this.reject) throw new Error('Book failed after write');
      return added;
    }
  }
  const book = new FailingBook();
  const { recorder, execution } = fixture(book);
  const notifications = [];
  recorder.subscribe((record) => notifications.push(record));
  const before = execution.childIds;
  const operation = new OperationRecord(operationDefinition(execution.id, 'operation'), {});
  book.reject = true;
  assert.throws(() => recorder.add(operation), /Book failed after write/);
  assert.equal(book.get(operation.id), undefined);
  assert.equal(execution.childIds, before);
  book.reject = false;
  assert.deepEqual(notifications, []);
  recorder.add(operation);
  assert.deepEqual(execution.childIds, [operation.id]);
  assert.deepEqual(notifications, [operation]);
});

test('registration prevents reentrant writes, while subscribers can register after the commit', () => {
  class ReentrantBook extends RecordBook {
    onAdd;
    add(record) {
      this.onAdd?.();
      return super.add(record);
    }
  }
  const book = new ReentrantBook();
  const { recorder, execution } = fixture(book);
  const operation = new OperationRecord(operationDefinition(execution.id, 'operation'), {});
  const extra = new BaseRecord({});
  book.onAdd = () => recorder.add(extra);
  assert.throws(() => recorder.add(operation), /cannot reenter/);
  assert.equal(recorder.book.get(extra.id), undefined);
  assert.deepEqual(execution.childIds, []);
  book.onAdd = undefined;
  recorder.subscribe((record) => {
    if (record === operation) recorder.add(extra);
  });
  recorder.add(operation);
  assert.equal(recorder.book.get(extra.id), extra);
  assert.deepEqual(execution.childIds, [operation.id]);
});

test('scope queries and end checks follow the tree while event snapshots follow sequence', () => {
  const { recorder, execution } = fixture();
  const operation = OperationRecordHelper.create(recorder, operationDefinition(execution.id, 'operation'), {});
  const attempt = AttemptRecordHelper.create(recorder, attemptDefinition(operation.id), {});
  // Child traversal groups events by call, unlike their original occurrence sequence.
  const boundary = (call, sequence, type) => recorder.add(new InvocationBoundaryRecord({ executionId: execution.id, callId: call.id, sequence, occurredAt: recorder.clock.now(), offsetMs: sequence }, { type }));
  boundary(execution, 1, 'call');
  boundary(operation, 2, 'call');
  boundary(attempt, 3, 'call');
  assert.throws(() => ExecutionRecordHelper.complete(recorder, execution.id, {}), /active operations/);
  assert.throws(() => OperationRecordHelper.complete(recorder, operation.id, {}), /active attempts/);
  AttemptRecordHelper.complete(recorder, attempt.id, {});
  boundary(attempt, 4, 'return');
  OperationRecordHelper.complete(recorder, operation.id, {});
  boundary(operation, 5, 'return');
  ExecutionRecordHelper.complete(recorder, execution.id, {});
  boundary(execution, 6, 'return');
  const snapshot = ExecutionRecordHelper.snapshot(recorder, execution.id);
  assert.deepEqual(
    snapshot.operations.map((record) => record.id),
    [operation.id],
  );
  assert.deepEqual(
    snapshot.attempts.map((record) => record.id),
    [attempt.id],
  );
  assert.deepEqual(
    snapshot.events.map((record) => record.sequence),
    [1, 2, 3, 4, 5, 6],
  );
});
