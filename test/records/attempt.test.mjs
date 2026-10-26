import { callFor, recordFor } from '../fixtures/lifecycle.mjs';
import { ChildCallFailure } from '@capix/server-runtime';
import { ExecutionRecordHelper } from '@capix/records';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';
import { TestOperation } from '../fixtures/operation.mjs';
import { TestAttempt } from '../fixtures/attempt.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExceptionContract } from '@capix/server-runtime';
import { Recorder, BaseRecord, CallableRecord, OperationRecord, OperationRecordHelper, AttemptRecordHelper, RecordBook } from '@capix/records';
import { createBoundRuntime, createRecordScope, observeCall } from '../fixtures/runtime.mjs';
import { test } from 'node:test';

import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';

function setup() {
  const runtime = createBoundRuntime({ recorder: new Recorder(new RecordBook()) });
  const executionLifecycle = lifecycleFor(runtime).execution({ input: {}, settings: {} });
  const execution = executionLifecycle.begin();
  const operationLifecycle = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {});
  const operation = operationLifecycle.begin();
  const definition = { name: 'acceptText', label: '接纳文本', source: 'test', caller: 'operation', callee: 'processing' };
  const attempt = new TestAttempt(runtime, definition.name);
  return { runtime, executionLifecycle, execution, operationLifecycle, operation, definition, attempt };
}

test('each named action invocation has its own attempt; an unsuccessful attempt does not end its operation', async () => {
  const { runtime, executionLifecycle, execution, operationLifecycle, operation, attempt } = setup();
  const input = { text: 'original' };
  const contract = new ExceptionContract('ATTEMPT_REJECTED');
  const failure = contract.create('first processing failed', {});
  await assert.rejects(
    invoke(lifecycleFor(runtime).attempt(operation, attempt, input), () => {
      throw failure;
    }),
    (error) => error instanceof ChildCallFailure && error.exception === failure,
  );
  assert.equal(operation.status, 'running');
  const secondLifecycle = lifecycleFor(runtime).attempt(operation, attempt, input);
  const second = secondLifecycle.begin();
  const secondRecord = recordFor(second);
  assert.ok(secondRecord instanceof BaseRecord && secondRecord instanceof CallableRecord);
  assert.equal(secondRecord.structureKind, 'node');
  assert.equal(secondRecord instanceof OperationRecord, false);
  assert.equal('executionId' in second, false);
  assert.equal('operationInstanceId' in second, false);
  assert.equal(second.signal, operation.signal);
  assert.equal(second.operationContext, undefined);
  const during = observeCall(runtime.recording, callFor(execution));
  validateExecutionRecordSnapshot(during);
  assert.equal(during.operations.length, 1);
  assert.deepEqual(
    during.attempts.map((attempt) => attempt.status),
    ['failed', 'running'],
  );
  assert.notEqual(during.attempts[0].id, during.attempts[1].id);
  input.text = 'changed';
  assert.equal(second.input.text, 'changed');
  assert.equal(secondRecord.value.input.text, 'original');
  const output = { accepted: true };
  secondLifecycle.succeed(second, output);
  operationLifecycle.succeed(operation, output);
  executionLifecycle.succeed(execution, output);
  output.accepted = false;
  assert.equal(second.state.output.accepted, false);
  assert.equal(readOutput(secondRecord.value).accepted, true);
  assert.throws(() => second.complete({}), /ended/);
  assert.throws(() => lifecycleFor(runtime).attempt(operation, attempt, {}).begin(), /ended/);
  const final = observeCall(runtime.recording, callFor(execution));
  validateExecutionRecordSnapshot(final);
  assert.deepEqual(
    final.attempts.map((attempt) => attempt.status),
    ['failed', 'succeeded'],
  );
  assert.equal(projectExecution(final).status, 'succeeded');
  assert.equal(during.attempts[1].status, 'running');
});

test('current calls omit callee while historical record participants remain extensible metadata', () => {
  const { runtime, execution, operation, attempt } = setup();
  lifecycleFor(runtime).attempt(operation, attempt, {}).begin();
  const snapshot = observeCall(runtime.recording, callFor(execution));
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(snapshot.attempts[0].callee, undefined);

  for (const kind of ['operations', 'attempts']) {
    for (const field of ['callee']) {
      const extended = structuredClone(snapshot);
      extended[kind][0][field] = 'custom-capability';
      validateExecutionRecordSnapshot(extended);
      for (const invalid of [null, 1, {}, '', '   ']) {
        const malformed = structuredClone(snapshot);
        malformed[kind][0][field] = invalid;
        assert.throws(() => validateExecutionRecordSnapshot(malformed));
      }
    }
  }

  const unrelated = structuredClone(snapshot);
  unrelated.attempts[0].parentId = 'missing-operation';
  assert.throws(() => validateExecutionRecordSnapshot(unrelated));
});

test('attempt ownership uses direct record ownership and rejects missing or incorrectly typed parents', (t) => {
  const { runtime, execution, operationRecord, declaration } = legacySetup();
  const definition = { ...declaration, contextId: randomUUID(), operationId: operationRecord.id };
  for (const operationId of ['missing', execution.id]) {
    assert.throws(() => AttemptRecordHelper.create(runtime.recorder, { ...definition, operationId }, {}), /Operation does not exist/);
  }
  const attempt = AttemptRecordHelper.create(runtime.recorder, definition, {});
  t.mock.method(runtime.recorder.book, 'values', () => {
    throw new Error('Must not scan Book');
  });
  assert.deepEqual(AttemptRecordHelper.findByOperation(runtime.recorder, operationRecord.id), [attempt]);
  assert.throws(() => AttemptRecordHelper.get(runtime.recorder.book, operationRecord.id), /Attempt does not exist/);
  const otherRecord = OperationRecordHelper.create(runtime.recorder, { executionId: execution.id, contextId: randomUUID(), operationInstanceId: 'other', operation: 'other', label: 'Other', source: 'test', caller: 'execution', callee: 'operation' }, {});
  assert.deepEqual(AttemptRecordHelper.findByOperation(runtime.recorder, otherRecord.id), []);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => AttemptRecordHelper.complete(runtime.recorder, attempt.id, cycle), /cyclic/);
  assert.equal(attempt.status, 'running');
  assert.equal(Object.hasOwn(attempt.value, 'output'), false);
  const error = { code: 'TEST', message: 'failure', detail: { value: 1 } };
  AttemptRecordHelper.fail(runtime.recorder, attempt.id, error);
  error.detail.value = 2;
  assert.equal(attempt.value.error.detail.value, 1);
  assert.throws(() => AttemptRecordHelper.fail(runtime.recorder, attempt.id, error), /ended/);
});

test('failed attempt registration leaves no partial record or child reference', (t) => {
  const { runtime, operationRecord, declaration } = legacySetup();
  const definition = { ...declaration, contextId: randomUUID(), operationId: operationRecord.id };
  const failure = new Error('book failed');
  const originalSize = [...runtime.recorder.book.values()].length;
  const before = operationRecord.childIds;
  t.mock.method(runtime.recorder.book, 'add', () => {
    throw failure;
  });
  assert.throws(
    () => AttemptRecordHelper.create(runtime.recorder, definition, {}),
    (error) => error.code === 'RECORDING_FAILED' && error.cause === failure,
  );
  assert.equal([...runtime.recorder.book.values()].length, originalSize);
  assert.equal(operationRecord.childIds, before);
});

function legacySetup() {
  const recorder = new Recorder(new RecordBook());
  const root = createRecordScope(recorder);
  const execution = ExecutionRecordHelper.create(recorder, { contextId: randomUUID(), parentId: root.id }, { input: null });
  const operationRecord = OperationRecordHelper.create(recorder, { executionId: execution.id, contextId: randomUUID(), operationInstanceId: 'fixture', operation: 'legacy', label: 'Legacy', source: 'test', caller: 'execution', callee: 'operation' }, {});
  const declaration = { name: 'acceptText', label: '接纳文本', source: 'test', caller: 'operation', callee: 'processing' };
  return { runtime: { recorder }, execution, operationRecord, declaration };
}
