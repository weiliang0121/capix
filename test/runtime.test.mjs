import { readOutput } from '../dist/shared/records/invocation.js';
import { TestOperation } from './fixtures/operation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoke } from '../dist/server/invocation/invoke.js';
import { Clock } from '../dist/server/runtime/clock.js';
import { Runtime } from '../dist/server/runtime/runtime.js';
import { RuntimeRecorder } from '../dist/server/records/recorder.js';
import { RecordBook, RecordIndex, OperationRecordHelper } from '../dist/server/records/index.js';
import { RuntimeError } from '../dist/server/errors/error.js';
import { ExecutionContext } from '../dist/server/context/execution.js';
import { OperationContext } from '../dist/server/context/operation.js';
import { validateSnapshot, projectExecution } from '../dist/shared/execution/project.js';

const lifecycles = new WeakMap();
const begin = (runtime) => {
  const lifecycle = runtime.execution({ input: {}, settings: {} });
  const context = lifecycle.begin();
  lifecycles.set(context, lifecycle);
  return context;
};
const createRecorder = (clock = new Clock(), publish) => new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), new RecordIndex((record) => record.executionId), clock, publish);

test('Runtime passes live Contexts; records retain separate identities, relations and snapshots', async () => {
  const recorder = createRecorder(),
    runtime = new Runtime(recorder),
    execution = begin(runtime);
  assert.ok(execution instanceof ExecutionContext);
  const input = { count: 0 };
  let parent, child;
  const output = await invoke(runtime.operation(execution, new TestOperation(runtime), input), async (context) => {
    parent = context;
    assert.ok(context instanceof OperationContext);
    assert.equal(context.input, input);
    assert.equal(context.executionContext, execution);
    assert.notEqual(recorder.record(context.id).id, context.id);
    assert.equal(recorder.record(context.id).value.input.count, 0);
    context.input.count++;
    return invoke(runtime.operation(execution, new TestOperation(runtime), context.input, context), (nested) => {
      child = nested;
      return nested.input;
    });
  });
  assert.equal(output, input);
  assert.equal(parent.state.output, input);
  assert.equal(Object.hasOwn(child, 'parentOperationId'), false);
  const parentRecord = recorder.record(parent.id),
    childRecord = recorder.record(child.id);
  assert.equal(childRecord.parentOperationId, parentRecord.id);
  assert.equal(parentRecord.value.input.count, 0);
  assert.equal(readOutput(parentRecord.value).count, 1);
  lifecycles.get(execution).succeed(execution, output);
  validateSnapshot(recorder.snapshot(execution));
});

test('Runtime rejects ended or mismatched parent Contexts and preserves original work failures', async () => {
  const recorder = createRecorder(),
    runtime = new Runtime(recorder),
    execution = begin(runtime);
  let entered = false;
  const ended = begin(runtime);
  lifecycles.get(ended).succeed(ended, {});
  await assert.rejects(
    invoke(runtime.operation(ended, new TestOperation(runtime), {}), () => {
      entered = true;
      return {};
    }),
    /ended/,
  );
  assert.equal(entered, false);
  const otherExecution = begin(runtime);
  const otherParent = new OperationContext(otherExecution, {});
  assert.throws(() => runtime.operation(execution, new TestOperation(runtime), {}, otherParent).begin(), /another execution/);
  lifecycles.get(otherExecution).succeed(otherExecution, {});
  assert.equal(OperationRecordHelper.findByExecution(recorder.book, recorder.operationIndex, recorder.record(execution.id).id).length, 0);
  const failure = new RuntimeError('TEST_ERROR', 'test failure');
  let failed;
  await assert.rejects(
    invoke(runtime.operation(execution, new TestOperation(runtime), {}), (context) => {
      failed = context;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(failed.state.error, failure);
  assert.notEqual(recorder.record(failed.id).value.error, failure);
  assert.equal(recorder.record(failed.id).value.error.code, 'TEST_ERROR');
  lifecycles.get(execution).fail(execution, failure);
  validateSnapshot(recorder.snapshot(execution));
});

test('Injected Clock measures recording boundaries without becoming live Context state', async () => {
  class ManualClock extends Clock {
    elapsed = 100;
    wall = '2026-09-21T01:00:00.000Z';
    now() {
      return this.wall;
    }
    tick() {
      return this.elapsed;
    }
  }
  const clock = new ManualClock(),
    published = [];
  const recorder = createRecorder(clock, (snapshot) => {
    validateSnapshot(snapshot);
    published.push(snapshot);
  });
  const runtime = new Runtime(recorder),
    execution = begin(runtime);
  assert.equal(recorder.record(execution.id).value.startedAt, clock.wall);
  clock.elapsed = 110;
  let resolve;
  const pending = invoke(
    runtime.operation(execution, new TestOperation(runtime), {}),
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const during = recorder.snapshot(execution);
  validateSnapshot(during);
  clock.wall = '2026-09-20T01:00:00.000Z';
  clock.elapsed = 135;
  resolve({ result: true });
  const output = await pending;
  clock.elapsed = 150;
  lifecycles.get(execution).succeed(execution, output);
  const facts = recorder.snapshot(execution);
  assert.equal(execution.status, 'succeeded');
  assert.equal(facts.execution.status, 'succeeded');
  assert.deepEqual(
    facts.events.map((event) => event.offsetMs),
    [0, 10, 35, 50],
  );
  assert.deepEqual(
    facts.events.map((event) => event.value.type),
    ['call', 'call', 'return', 'return'],
  );
  assert.equal(during.operations[0].status, 'running');
  assert.equal(published.length, 4);
  assert.equal(projectExecution(facts).callSequence.calls[1].durationMs, 25);
  assert.equal(projectExecution(facts).durationMs, 50);
});

test('record creation captures instance descriptions at begin without storing them in Context', () => {
  const recorder = createRecorder();
  const runtime = new Runtime(recorder);
  const execution = begin(runtime);
  const instance = new TestOperation(runtime);
  let reads = 0;
  Object.defineProperty(instance, 'label', {
    configurable: true,
    get() {
      reads++;
      return 'initial label';
    },
  });
  const operationLifecycle = runtime.operation(execution, instance, 'operation input');
  assert.equal(reads, 0);
  const operation = operationLifecycle.begin();
  const operationRecord = recorder.record(operation.id);
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(operation).sort(), ['executionContext', 'id', 'input']);
  assert.equal(operationRecord.operationInstanceId, instance.id);
  assert.equal(operationRecord.operation, instance.name);
  assert.equal(operationRecord.label, 'initial label');
  assert.equal(operationRecord.source, instance.source);
  Object.defineProperty(instance, 'label', {
    get() {
      throw new Error('Completion must not read the instance description');
    },
  });

  const attemptInstance = instance.actions[0];
  const attemptLifecycle = runtime.attempt(operation, attemptInstance, 'action input');
  const attempt = attemptLifecycle.begin();
  const attemptRecord = recorder.record(attempt.id);
  assert.deepEqual(Object.keys(attempt).sort(), ['id', 'input', 'operationContext']);
  assert.equal(attemptRecord.name, attemptInstance.name);
  assert.equal(attemptRecord.label, attemptInstance.label);
  assert.equal(attemptRecord.source, attemptInstance.source);
  assert.equal(attemptRecord.caller, 'operation');
  assert.equal(attemptRecord.callee, 'processing');
  assert.equal(runtime.getOperationContext(attempt), operation);
  assert.equal(runtime.getExecutionContext(attempt), execution);
  attemptLifecycle.succeed(attempt, 'action output');
  operationLifecycle.succeed(operation, 'operation output');
  lifecycles.get(execution).succeed(execution, 'execution output');
  assert.equal(reads, 1);
  assert.equal(operationRecord.label, 'initial label');
  validateSnapshot(recorder.snapshot(execution));
});
