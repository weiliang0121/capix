import { callFor, recordFor } from '../fixtures/lifecycle.mjs';
import { ExecutionRecordHelper } from '@capix-observer/runtime';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import { TestOperation } from '../fixtures/operation.mjs';
import { TestAttempt } from '../fixtures/attempt.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExceptionContract, Recorder, BaseRecord, AttemptRecord, OperationRecord, AttemptRecordHelper, RecordBook } from '@capix-observer/runtime';
import { createRuntime, observeCall } from '../fixtures/runtime.mjs';
import { test } from 'node:test';

import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';

function setup() {
  const runtime = createRuntime({ recorder: new Recorder(new RecordBook()) });
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
  attempt.raises = [contract];
  const failure = contract.create('first processing failed', {});
  await assert.rejects(
    invoke(lifecycleFor(runtime).attempt(operation, attempt, input), () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(operation.status, 'running');
  const secondLifecycle = lifecycleFor(runtime).attempt(operation, attempt, input);
  const second = secondLifecycle.begin();
  const secondRecord = recordFor(second);
  assert.ok(secondRecord instanceof BaseRecord && secondRecord instanceof AttemptRecord);
  assert.equal(secondRecord instanceof OperationRecord, false);
  assert.equal('executionId' in second, false);
  assert.equal('operationInstanceId' in second, false);
  assert.equal(second.signal, operation.signal);
  assert.equal(second.operationContext, undefined);
  const during = observeCall(runtime.recording, callFor(execution));
  validateSnapshot(during);
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
  validateSnapshot(final);
  assert.deepEqual(
    final.attempts.map((attempt) => attempt.status),
    ['failed', 'succeeded'],
  );
  assert.equal(projectExecution(final).status, 'succeeded');
  assert.equal(during.attempts[1].status, 'running');
});

test('attempt ownership uses direct record ownership and rejects missing or incorrectly typed parents', (t) => {
  const { runtime, execution, operation, definition: declaration } = setup();
  const operationRecord = recordFor(operation);
  const definition = { ...declaration, contextId: randomUUID(), operationId: operationRecord.id };
  for (const operationId of ['missing', recordFor(execution).id]) {
    assert.throws(() => AttemptRecordHelper.create(runtime.recorder, { ...definition, operationId }, {}), /Operation does not exist/);
  }
  const attempt = AttemptRecordHelper.create(runtime.recorder, definition, {});
  t.mock.method(runtime.recorder.book, 'values', () => {
    throw new Error('Must not scan Book');
  });
  assert.deepEqual(AttemptRecordHelper.findByOperation(runtime.recorder, operationRecord.id), [attempt]);
  assert.throws(() => AttemptRecordHelper.get(runtime.recorder.book, operationRecord.id), /Attempt does not exist/);
  const other = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}).begin();
  const otherRecord = recordFor(other);
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
  const { runtime, operation, definition: declaration } = setup();
  const operationRecord = recordFor(operation);
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
