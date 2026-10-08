import { contextWithSource, sourceFor } from './fixtures/observer.mjs';
import { callFor, recordFor } from './fixtures/lifecycle.mjs';
import { OperationRecordHelper } from '@capix-observer/runtime';
import { ExecutionRecordHelper } from '@capix-observer/runtime';
import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationContext, ExecutionContext, Transcript, Recorder, RecordBook, createRuntime } from '@capix-observer/runtime';

import { TestOperation } from './fixtures/operation.mjs';

const options = { input: {}, settings: {} };
const recorder = () => new Recorder(new RecordBook());

test('Context keeps live refs, separates undefined outcomes, and fixes execution configuration and Transcript visibility', () => {
  const input = { text: 'hello' },
    settings = { model: 'original', temperature: 0 },
    transcript = new Transcript([]),
    controller = new AbortController();
  const context = contextWithSource(input, { settings, transcript, signal: controller.signal });
  settings.model = 'changed';
  assert.equal(sourceFor(context).settings.model, 'original');
  assert.ok(Object.isFrozen(sourceFor(context).settings));
  assert.equal(context.input, input);
  assert.equal(sourceFor(context).transcriptRange.transcript, transcript);
  assert.equal(sourceFor(context).transcriptRange.end, 0);
  assert.equal(context.signal, controller.signal);
  transcript.append({ role: 'user', content: 'new' });
  assert.equal(sourceFor(context).transcriptRange.end, 0);
  assert.throws(() => sourceFor(context).transcriptRange.read(0), RangeError);
  controller.abort();
  assert.equal(context.signal.aborted, true);
  const initial = context.state;
  context.complete(undefined);
  assert.deepEqual(initial, { status: 'running' });
  assert.deepEqual(context.state, { status: 'succeeded', output: undefined });
  assert.throws(() => {
    context.state.status = 'failed';
  }, TypeError);
  assert.throws(() => context.fail('later'), /ended/);
  const failed = new InvocationContext(undefined);
  failed.fail(undefined);
  assert.deepEqual(failed.state, { status: 'failed', error: undefined });
});

test('Operation executes named actions without records and preserves non-JSON intermediate and output refs', async () => {
  const runtime = createRuntime(),
    seen = [],
    input = new Map([['content', 'hello']]);
  const fn = () => input.get('content');
  const node = new TestOperation(runtime, {
    load(value) {
      seen.push('load');
      assert.equal(value, input);
      return fn;
    },
    transform(value) {
      seen.push('transform');
      assert.equal(value, fn);
      return new Set([value()]);
    },
    accept(value, context) {
      seen.push('accept');
      assert.equal(context.operationContext, undefined);
      assert.equal(context.input, value);
      return value;
    },
  });
  let execution;
  const result = await invoke(lifecycleFor(runtime).execution({ ...options, input }), (context) => {
    execution = context;
    return node.call(callFor(context), context.input);
  });
  assert.deepEqual(seen, ['load', 'transform', 'accept']);
  assert.ok(result instanceof Set);
  assert.equal(execution.state.output, result);
  assert.equal(runtime.recorder, undefined);
});

test('Unrecordable execute result stops acceptance without rerunning work', async () => {
  const records = recorder(),
    runtime = createRuntime({ recorder: records }),
    root = lifecycleFor(runtime).execution(options),
    execution = root.begin();
  let context,
    count = 0;
  const result = new Map([['value', 1]]);
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}), (current) => {
      context = current;
      count++;
      return result;
    }),
  );
  assert.equal(count, 1);
  assert.equal(context.status, 'failed');
  assert.equal(context.progress.result.output, result);
  assert.equal(recordFor(context).status, 'failed');
  assert.equal(recordFor(context).value.error.code, 'RECORDING_FAILED');
  assert.equal(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).events.filter((event) => event.callId === recordFor(context).id).length, 2);
  // The failed child is fully recorded; the parent remains responsible for its own outcome.
  root.succeed(execution, {});
  assert.equal(execution.status, 'succeeded');
  assert.equal(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).execution.status, 'succeeded');
});

test('Work and failure-registration errors remain distinct; Context keeps the original thrown value', async (t) => {
  const records = recorder(),
    runtime = createRuntime({ recorder: records });
  const failure = { reason: 'work failed' },
    registration = new Error('record unavailable');
  t.mock.method(ExecutionRecordHelper, 'fail', () => {
    throw registration;
  });
  let execution;
  await assert.rejects(
    invoke(lifecycleFor(runtime).execution(options), (context) => {
      execution = context;
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.equal(error.errors[1].code, 'RECORDING_FAILED');
      assert.equal(error.errors[1].cause, registration);
      assert.equal(error.cause, failure);
      return true;
    },
  );
  assert.equal(execution.status, 'failed');
  assert.equal(execution.state.error, failure);
  assert.equal(recordFor(execution).status, 'running');
});

test('Failed begin prevents work without changing the parent Context', async (t) => {
  const records = recorder(),
    runtime = createRuntime({ recorder: records }),
    root = lifecycleFor(runtime).execution(options),
    execution = root.begin();
  const failure = new Error('cannot record start');
  let child,
    entered = false;
  const recording = OperationRecordHelper.recording;
  t.mock.method(OperationRecordHelper, 'recording', (...args) => ({
    ...recording.call(OperationRecordHelper, ...args),
    begin(context) {
      child = context;
      throw failure;
    },
  }));
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}), () => {
      entered = true;
      return {};
    }),
    (error) => error.code === 'RECORDING_FAILED' && error.cause === failure,
  );
  assert.equal(entered, false);
  assert.equal(child.state.error.cause, failure);
  root.succeed(execution, {});
  assert.equal(execution.status, 'succeeded');
  assert.equal(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).execution.status, 'succeeded');
  assert.equal(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).events.at(-1).value.type, 'return');
});

test('Contexts hide ancestor access while retaining lifecycle checks through nested parents', async () => {
  const runtime = createRuntime();
  let attempt;
  let child;
  const operation = new TestOperation(runtime, {
    readOwn(input, context) {
      attempt = context;
      assert.equal(context.operationContext, undefined);
      assert.equal(context.executionContext, undefined);
      assert.equal(context.settings, undefined);
      context.requireActive();
      return input;
    },
  });
  await invoke(lifecycleFor(runtime).execution({ input: 'root', settings: {} }), (root) =>
    invoke(lifecycleFor(runtime).operation(root, new TestOperation(runtime), 'nested'), (parent) => {
      child = parent;
      return operation.call(callFor(parent), 'work');
    }),
  );
  assert.equal(runtime.getExecutionContext, undefined);
  assert.equal(runtime.getOperationContext, undefined);
  assert.equal(child.executionContext, undefined);
  assert.throws(() => attempt.requireActive(), /ended/);
  assert.throws(() => child.requireActive(), /ended/);
  assert.equal(runtime.recorder, undefined);
});
