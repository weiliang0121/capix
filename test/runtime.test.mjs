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

const definition = { nodeId: 'test-node', operation: 'test', label: 'test', source: 'test', caller: 'pipeline', callee: 'processing' };
const lifecycles = new WeakMap();
const begin = (runtime) => {
  const lifecycle = runtime.execution({ input: {}, settings: {} });
  const context = lifecycle.begin();
  lifecycles.set(context, lifecycle);
  return context;
};
const createRecorder = (clock = new Clock(), publish) => new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), clock, publish);

test('Runtime passes live Contexts; records retain separate identities, relations and snapshots', async () => {
  const recorder = createRecorder(),
    runtime = new Runtime(recorder),
    execution = begin(runtime);
  assert.ok(execution instanceof ExecutionContext);
  const input = { count: 0 };
  let parent, child;
  const output = await invoke(runtime.operation(execution, definition, input), async (context) => {
    parent = context;
    assert.ok(context instanceof OperationContext);
    assert.equal(context.input, input);
    assert.equal(context.executionId, execution.id);
    assert.notEqual(recorder.record(context.id).id, context.id);
    assert.equal(recorder.record(context.id).value.input.count, 0);
    context.input.count++;
    return invoke(runtime.operation(execution, definition, context.input, context), (nested) => {
      child = nested;
      return nested.input;
    });
  });
  assert.equal(output, input);
  assert.equal(parent.state.output, input);
  assert.equal(child.parentOperationId, parent.id);
  const parentRecord = recorder.record(parent.id),
    childRecord = recorder.record(child.id);
  assert.equal(childRecord.parentOperationId, parentRecord.id);
  assert.equal(parentRecord.value.input.count, 0);
  assert.equal(parentRecord.value.output.count, 1);
  lifecycles.get(execution).succeed(execution, output);
  validateSnapshot(recorder.snapshot(execution));
});

test('Runtime rejects foreign live scopes and preserves original work failures independently of records', async () => {
  const recorder = createRecorder(),
    runtime = new Runtime(recorder),
    execution = begin(runtime);
  let entered = false;
  const foreign = begin(new Runtime());
  await assert.rejects(
    invoke(runtime.operation(foreign, definition, {}), () => {
      entered = true;
      return {};
    }),
    /does not belong/,
  );
  assert.equal(entered, false);
  assert.equal(OperationRecordHelper.findByExecution(recorder.book, recorder.operationIndex, recorder.record(execution.id).id).length, 0);
  const failure = new RuntimeError('TEST_ERROR', 'test failure');
  let failed;
  await assert.rejects(
    invoke(runtime.operation(execution, definition, {}), (context) => {
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
    runtime.operation(execution, definition, {}),
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
    facts.events.map((event) => event.type),
    ['call', 'call', 'return', 'return'],
  );
  assert.equal(during.operations[0].status, 'running');
  assert.equal(published.length, 4);
  assert.equal(projectExecution(facts).callSequence.calls[1].durationMs, 25);
  assert.equal(projectExecution(facts).durationMs, 50);
});
