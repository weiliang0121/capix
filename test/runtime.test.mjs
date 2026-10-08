import { callFor, recordFor } from './fixtures/lifecycle.mjs';
import { subscribeExecutions } from '@capix-observer/service';
import { ExecutionRecordHelper } from '@capix-observer/runtime';
import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import { TestOperation } from './fixtures/operation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Clock, Recorder, RecordBook, OperationRecordHelper, RuntimeError, ExecutionContext, OperationContext, createRuntime } from '@capix-observer/runtime';

import { projectExecution } from '../apps/observer/.test-dist/observation/project.js';

const lifecycles = new WeakMap();
const begin = (runtime) => {
  const lifecycle = lifecycleFor(runtime).execution({ input: {}, settings: {} });
  const context = lifecycle.begin();
  lifecycles.set(context, lifecycle);
  return context;
};
const createRecorder = (clock = new Clock()) => new Recorder(new RecordBook(), { clock });

test('Runtime passes live Contexts; records retain separate identities, relations and snapshots', async () => {
  const recorder = createRecorder(),
    runtime = createRuntime({ recorder }),
    execution = begin(runtime);
  assert.ok(execution instanceof ExecutionContext);
  const input = { count: 0 };
  let parent, child;
  const output = await invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), input), async (context) => {
    parent = context;
    assert.ok(context instanceof OperationContext);
    assert.equal(context.input, input);
    assert.equal(context.signal, execution.signal);
    assert.equal(context.executionContext, undefined);
    assert.notEqual(recordFor(context).id, context.id);
    assert.equal(recordFor(context).value.input.count, 0);
    context.input.count++;
    return invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), context.input, context), (nested) => {
      child = nested;
      return nested.input;
    });
  });
  assert.equal(output, input);
  assert.equal(parent.state.output, input);
  assert.equal(Object.hasOwn(child, 'parentOperationId'), false);
  const parentRecord = recordFor(parent),
    childRecord = recordFor(child);
  assert.equal(childRecord.parentOperationId, parentRecord.id);
  assert.equal(parentRecord.value.input.count, 0);
  assert.equal(readOutput(parentRecord.value).count, 1);
  lifecycles.get(execution).succeed(execution, output);
  validateSnapshot(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)));
});

test('Runtime rejects ended or mismatched parent Contexts and preserves original work failures', async () => {
  const recorder = createRecorder(),
    runtime = createRuntime({ recorder }),
    execution = begin(runtime);
  let entered = false;
  const ended = begin(runtime);
  lifecycles.get(ended).succeed(ended, {});
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(ended, new TestOperation(runtime), {}), () => {
      entered = true;
      return {};
    }),
    /ended/,
  );
  assert.equal(entered, false);
  const otherExecution = begin(runtime);
  const otherParent = new OperationContext(otherExecution, {});
  assert.throws(() => lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}, otherParent).begin(), /another execution/);
  lifecycles.get(otherExecution).succeed(otherExecution, {});
  assert.equal(OperationRecordHelper.findByExecution(recorder, recordFor(execution).id).length, 0);
  const failure = new RuntimeError('TEST_ERROR', 'test failure');
  let failed;
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}), (context) => {
      failed = context;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(failed.state.error, failure);
  assert.notEqual(recordFor(failed).value.error, failure);
  assert.equal(recordFor(failed).value.error.code, 'TEST_ERROR');
  lifecycles.get(execution).fail(execution, failure);
  validateSnapshot(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)));
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
  const recorder = createRecorder(clock);
  const runtime = createRuntime({ recorder });
  subscribeExecutions(runtime.recording, (snapshot) => {
    validateSnapshot(snapshot);
    published.push(snapshot);
  });
  const execution = begin(runtime);
  assert.equal(recordFor(execution).value.startedAt, clock.wall);
  clock.elapsed = 110;
  let resolve;
  const pending = invoke(
    lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}),
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const during = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
  validateSnapshot(during);
  clock.wall = '2026-09-20T01:00:00.000Z';
  clock.elapsed = 135;
  resolve({ result: true });
  const output = await pending;
  clock.elapsed = 150;
  lifecycles.get(execution).succeed(execution, output);
  const facts = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
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
  assert.equal(published.length, 7); // Four boundaries plus execute start/return and receive return.
  assert.equal(projectExecution(facts).callSequence.calls[1].durationMs, 25);
  assert.equal(projectExecution(facts).durationMs, 50);
});

test('record creation captures instance descriptions at begin without storing them in Context', () => {
  const recorder = createRecorder();
  const runtime = createRuntime({ recorder });
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
  const operationLifecycle = lifecycleFor(runtime).operation(execution, instance, 'operation input');
  assert.equal(reads, 0);
  const operation = operationLifecycle.begin();
  const operationRecord = recordFor(operation);
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(operation).sort(), ['id', 'input', 'resources', 'signal']);
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
  const attemptLifecycle = lifecycleFor(runtime).attempt(operation, attemptInstance, 'action input');
  const attempt = attemptLifecycle.begin();
  const attemptRecord = recordFor(attempt);
  assert.deepEqual(Object.keys(attempt).sort(), ['id', 'input', 'resources', 'signal']);
  assert.equal(attemptRecord.name, attemptInstance.name);
  assert.equal(attemptRecord.label, attemptInstance.label);
  assert.equal(attemptRecord.source, attemptInstance.source);
  assert.equal(attemptRecord.caller, 'operation');
  assert.equal(attemptRecord.callee, 'processing');
  assert.equal(attempt.operationContext, undefined);
  attempt.requireActive();
  attemptLifecycle.succeed(attempt, 'action output');
  operationLifecycle.succeed(operation, 'operation output');
  lifecycles.get(execution).succeed(execution, 'execution output');
  assert.equal(reads, 1);
  assert.equal(operationRecord.label, 'initial label');
  validateSnapshot(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)));
});
