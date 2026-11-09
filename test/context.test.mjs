import { contextWithSource, sourceFor } from './fixtures/observer.mjs';
import { callFor, recordFor } from './fixtures/lifecycle.mjs';
import { InvocationRecordHelper, CallableRecord } from '@weiliang0121/capix-records';
import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationContext } from '@weiliang0121/capix-runtime';
import { Recorder, RecordBook } from '@weiliang0121/capix-records';
import { Transcript } from '@weiliang0121/capix-transcript';
import { createBoundRuntime, observeCall } from './fixtures/runtime.mjs';

import { TestOperation } from './fixtures/operation.mjs';

const options = { input: {}, settings: {} };
const recorder = () => new Recorder(new RecordBook());

test('Context fixes data input, separates undefined outcomes, and fixes execution configuration and Transcript visibility', () => {
  const input = { text: 'hello' },
    settings = { model: 'original', temperature: 0 },
    transcript = new Transcript([]),
    controller = new AbortController();
  const context = contextWithSource(input, { settings, transcript, signal: controller.signal });
  settings.model = 'changed';
  assert.equal(sourceFor(context).settings.model, 'original');
  assert.ok(Object.isFrozen(sourceFor(context).settings));
  assert.deepEqual(context.input, input);
  assert.notEqual(context.input, input);
  input.text = 'changed';
  assert.equal(context.input.text, 'hello');
  assert.equal(Object.isFrozen(context.input), true);
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
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.error, undefined);
  assert.equal(Object.isFrozen(failed.state.diagnostic), true);
});

test('Operation composes named actions with stable data while local capabilities remain outside delivery', async () => {
  const runtime = createBoundRuntime(),
    seen = [],
    input = { content: 'hello' };
  const localRead = () => input.content;
  const node = new TestOperation(runtime, {
    load(value) {
      seen.push('load');
      assert.deepEqual(value, input);
      assert.notEqual(value, input);
      assert.equal(Object.isFrozen(value), true);
      return { content: localRead() };
    },
    transform(value) {
      seen.push('transform');
      assert.deepEqual(value, { content: 'hello' });
      assert.equal(Object.isFrozen(value), true);
      return [value.content];
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
  assert.deepEqual(result, ['hello']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(execution.state.output, result);
  assert.equal(runtime.recorder, undefined);
});

test('an unsupported execute value fails before successful delivery and keeps the actual failure record', async () => {
  const records = recorder();
  const runtime = createBoundRuntime({ recorder: records });
  const root = lifecycleFor(runtime).execution(options);
  const execution = root.begin();
  let context;
  let count = 0;
  const result = new Map([['value', 1]]);
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}), (current) => {
      context = current;
      count++;
      return result;
    }),
    (error) => error.code === 'UNSUPPORTED_VALUE',
  );
  assert.equal(count, 1);
  assert.equal(context.status, 'failed');
  assert.equal(context.progress.result.status, 'failed');
  assert.equal(context.progress.result.error, context.state.error);
  assert.equal(context.progress.result.diagnostic.code, 'UNSUPPORTED_VALUE');
  assert.equal(recordFor(context).status, 'failed');
  assert.equal(recordFor(context).value.error.code, 'UNSUPPORTED_VALUE');
  assert.throws(
    () => callFor(execution).requireHealthy(),
    (error) => error === context.state.error,
  );
  root.fail(execution, context.state.error);
  assert.equal(execution.status, 'failed');
});

test('Work and failure-registration errors remain distinct; Context keeps the original thrown value', async (t) => {
  const records = recorder(),
    runtime = createBoundRuntime({ recorder: records });
  const failure = { reason: 'work failed' },
    registration = new Error('record unavailable');
  const finish = InvocationRecordHelper.finish;
  t.mock.method(InvocationRecordHelper, 'finish', (...args) => {
    if (args[1].structureKind === 'group') throw registration;
    return finish(...args);
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
      assert.equal(error.errors[1].code, 'OBSERVATION_FAILED');
      assert.equal(error.errors[1].cause, registration);
      assert.equal(error.cause, failure);
      return true;
    },
  );
  assert.equal(execution.status, 'failed');
  assert.equal(execution.state.error, failure);
  assert.equal(recordFor(execution).status, 'running');
});

test('a strict start-observation failure prevents child work and is visible to its parent', async (t) => {
  const records = recorder();
  const runtime = createBoundRuntime({ recorder: records });
  const root = lifecycleFor(runtime).execution(options);
  const execution = root.begin();
  const failure = new Error('cannot record start');
  let entered = false;
  const add = records.add.bind(records);
  t.mock.method(records, 'add', (record) => {
    if (record instanceof CallableRecord && record.structureKind === 'group') throw failure;
    return add(record);
  });
  await assert.rejects(
    invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), {}), () => {
      entered = true;
      return {};
    }),
    (error) => error.code === 'OBSERVATION_FAILED' && error.cause === failure,
  );
  assert.equal(entered, false);
  const relation = callFor(execution).children.values()[0];
  assert.equal(relation.invocation.context.state.error.cause, failure);
  assert.equal(relation.returned.status, 'failed');
  assert.equal(execution.status, 'running');
  assert.throws(
    () => callFor(execution).requireHealthy(),
    (error) => error === relation.returned.error,
  );
  root.fail(execution, relation.returned.error);
  assert.equal(observeCall(runtime.recording, callFor(execution)).execution.status, 'failed');
});

test('Contexts hide ancestor access while retaining lifecycle checks through nested parents', async () => {
  const runtime = createBoundRuntime();
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
