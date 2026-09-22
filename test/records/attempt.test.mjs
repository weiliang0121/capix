import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuntimeRecorder } from '../../dist/server/records/recorder.js';
import { test } from 'node:test';
import { invoke } from '../../dist/server/invocation/invoke.js';
import { Runtime } from '../../dist/server/runtime/runtime.js';
import { RuntimeRecord, AttemptRecord, OperationRecord, AttemptRecordHelper, RecordBook, RecordIndex } from '../../dist/server/records/index.js';
import { projectExecution, validateSnapshot } from '../../dist/shared/execution/project.js';

function setup() {
  const runtime = new Runtime(new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId)));
  const executionLifecycle = runtime.execution({ input: {}, settings: {} });
  const execution = executionLifecycle.begin();
  const operationLifecycle = runtime.operation(execution, { nodeId: 'n', operation: 'echo', label: 'echo', source: 'test', caller: 'pipeline', callee: 'operation' }, {});
  const operation = operationLifecycle.begin();
  const definition = { phase: 'after', source: 'test', caller: 'operation', callee: 'processing' };
  return { runtime, executionLifecycle, execution, operationLifecycle, operation, definition };
}

test('each phase invocation has its own attempt; an unsuccessful attempt does not end its operation', async () => {
  const { runtime, executionLifecycle, execution, operationLifecycle, operation, definition } = setup();
  const input = { raw: { text: 'original' }, input: {} };
  const failure = new Error('first processing failed');
  await assert.rejects(
    invoke(runtime.attempt(operation, definition, input), () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(operation.status, 'running');
  const secondLifecycle = runtime.attempt(operation, definition, input);
  const second = secondLifecycle.begin();
  const secondRecord = runtime.recorder.record(second.id);
  assert.ok(secondRecord instanceof RuntimeRecord && secondRecord instanceof AttemptRecord);
  assert.equal(secondRecord instanceof OperationRecord, false);
  assert.equal('executionId' in second, false);
  assert.equal('nodeId' in second, false);
  assert.equal(second.operationId, operation.id);
  assert.throws(() => operationLifecycle.succeed(operation, {}), /active child contexts/);
  assert.throws(() => operationLifecycle.fail(operation, failure), /active child contexts/);
  assert.throws(() => executionLifecycle.succeed(execution, {}), /active child contexts/);
  const during = runtime.recorder.snapshot(execution);
  validateSnapshot(during);
  assert.equal(during.operations.length, 1);
  assert.deepEqual(
    during.attempts.map((attempt) => attempt.status),
    ['failed', 'running'],
  );
  assert.notEqual(during.attempts[0].id, during.attempts[1].id);
  input.raw.text = 'changed';
  assert.equal(second.input.raw.text, 'changed');
  assert.equal(secondRecord.value.input.raw.text, 'original');
  const output = { accepted: true };
  secondLifecycle.succeed(second, output);
  operationLifecycle.succeed(operation, output);
  executionLifecycle.succeed(execution, output);
  output.accepted = false;
  assert.equal(second.state.output.accepted, false);
  assert.equal(secondRecord.value.output.accepted, true);
  assert.throws(() => second.complete({}), /ended/);
  assert.throws(() => runtime.attempt(operation, definition, {}).begin(), /ended/);
  const final = runtime.recorder.snapshot(execution);
  validateSnapshot(final);
  assert.deepEqual(
    final.attempts.map((attempt) => attempt.status),
    ['failed', 'succeeded'],
  );
  assert.equal(projectExecution(final).status, 'succeeded');
  assert.equal(during.attempts[1].status, 'running');
});

test('attempt ownership uses operation index and rejects missing or incorrectly typed parents', (t) => {
  const { runtime, execution, operation, definition: declaration } = setup();
  const operationRecord = runtime.recorder.record(operation.id);
  const definition = { ...declaration, contextId: randomUUID(), operationId: operationRecord.id };
  for (const operationId of ['missing', runtime.recorder.record(execution.id).id]) {
    assert.throws(() => AttemptRecordHelper.create(runtime.recorder.book, runtime.recorder.attemptIndex, { ...definition, operationId }, {}), /Operation does not exist/);
  }
  const attempt = AttemptRecordHelper.create(runtime.recorder.book, runtime.recorder.attemptIndex, definition, {});
  t.mock.method(runtime.recorder.book, 'values', () => {
    throw new Error('Must not scan Book');
  });
  assert.deepEqual(AttemptRecordHelper.findByOperation(runtime.recorder.book, runtime.recorder.attemptIndex, operationRecord.id), [attempt]);
  assert.throws(() => AttemptRecordHelper.get(runtime.recorder.book, operationRecord.id), /Attempt does not exist/);
  const other = runtime.operation(execution, { nodeId: 'other', operation: 'other', label: 'other', source: 'test', caller: 'pipeline', callee: 'operation' }, {}).begin();
  const otherRecord = runtime.recorder.record(other.id);
  const wrongIndex = new RecordIndex(() => otherRecord.id);
  wrongIndex.add(attempt);
  assert.throws(() => AttemptRecordHelper.findByOperation(runtime.recorder.book, wrongIndex, otherRecord.id), /another operation/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => AttemptRecordHelper.complete(runtime.recorder.book, attempt.id, cycle), /cyclic/);
  assert.equal(attempt.status, 'running');
  assert.equal(Object.hasOwn(attempt.value, 'output'), false);
  const error = { code: 'TEST', message: 'failure', detail: { value: 1 } };
  AttemptRecordHelper.fail(runtime.recorder.book, attempt.id, error);
  error.detail.value = 2;
  assert.equal(attempt.value.error.detail.value, 1);
  assert.throws(() => AttemptRecordHelper.fail(runtime.recorder.book, attempt.id, error), /ended/);
});

test('failed attempt registration leaves no partial record or index entry', () => {
  const { runtime, operation, definition: declaration } = setup();
  const operationRecord = runtime.recorder.record(operation.id);
  const definition = { ...declaration, contextId: randomUUID(), operationId: operationRecord.id };
  const failure = new Error('index failed');
  const rejectedIndex = new RecordIndex(() => {
    throw failure;
  });
  const originalSize = [...runtime.recorder.book.values()].length;
  assert.throws(
    () => AttemptRecordHelper.create(runtime.recorder.book, rejectedIndex, definition, {}),
    (error) => error === failure,
  );
  assert.equal([...runtime.recorder.book.values()].length, originalSize);
  assert.deepEqual(rejectedIndex.get(operationRecord.id), []);
  const rejectedBook = {
    get: (id) => runtime.recorder.book.get(id),
    add() {
      throw failure;
    },
  };
  assert.throws(
    () => AttemptRecordHelper.create(rejectedBook, runtime.recorder.attemptIndex, definition, {}),
    (error) => error === failure,
  );
  assert.deepEqual(runtime.recorder.attemptIndex.get(operationRecord.id), []);
});
