import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeContext } from '../dist/server/context/context.js';
import { ExecutionContext } from '../dist/server/context/execution.js';
import { Transcript } from '../dist/server/transcript/transcript.js';
import { Runtime } from '../dist/server/runtime/runtime.js';
import { RuntimeRecorder } from '../dist/server/records/recorder.js';
import { RecordBook, RecordIndex } from '../dist/server/records/index.js';
import { invoke } from '../dist/server/invocation/invoke.js';
import { TestOperation } from './fixtures/operation.mjs';

const declaration = { operationInstanceId: 'test', operation: 'echo', label: 'echo', source: 'test', caller: 'execution', callee: 'operation' };
const options = { input: {}, settings: {} };
const recorder = () => new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), new RecordIndex((record) => record.executionId));

test('Context keeps live refs, separates undefined outcomes, and fixes execution configuration and Transcript visibility', () => {
  const input = { text: 'query' },
    settings = { model: 'original', temperature: 0 },
    transcript = new Transcript([]),
    controller = new AbortController();
  const context = new ExecutionContext(input, { settings, transcript, signal: controller.signal });
  settings.model = 'changed';
  assert.equal(context.settings.model, 'original');
  assert.ok(Object.isFrozen(context.settings));
  assert.equal(context.input, input);
  assert.equal(context.transcriptRange.transcript, transcript);
  assert.equal(context.transcriptRange.end, 0);
  assert.equal(context.signal, controller.signal);
  transcript.append({ role: 'user', content: 'new' });
  assert.equal(context.transcriptRange.end, 0);
  assert.throws(() => context.transcriptRange.read(0), RangeError);
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
  const failed = new RuntimeContext(undefined);
  failed.fail(undefined);
  assert.deepEqual(failed.state, { status: 'failed', error: undefined });
});

test('Operation executes full BCA without records and preserves non-JSON intermediate and output refs', async () => {
  const runtime = new Runtime(),
    seen = [],
    input = new Map([['query', 'hello']]);
  const fn = () => input.get('query');
  const node = new TestOperation(
    runtime,
    { name: 'echo', label: 'echo', source: 'test', phaseSource: 'test' },
    {
      before(value) {
        seen.push('before');
        assert.equal(value, input);
        return fn;
      },
      commit(value) {
        seen.push('commit');
        assert.equal(value, fn);
        return new Set([value()]);
      },
      after(value, original) {
        seen.push('after');
        assert.equal(original, input);
        return value;
      },
    },
  );
  let execution;
  const result = await invoke(runtime.execution({ ...options, input }), (context) => {
    execution = context;
    return node.call(context, context.input);
  });
  assert.deepEqual(seen, ['before', 'commit', 'after']);
  assert.ok(result instanceof Set);
  assert.equal(execution.state.output, result);
  assert.equal(runtime.recorder, undefined);
});

test('Record failure after work success preserves the live result and does not rerun work', async () => {
  const records = recorder(),
    runtime = new Runtime(records),
    root = runtime.execution(options),
    execution = root.begin();
  let context,
    count = 0;
  const result = new Map([['value', 1]]);
  await assert.rejects(
    invoke(runtime.operation(execution, declaration, {}), (current) => {
      context = current;
      count++;
      return result;
    }),
  );
  assert.equal(count, 1);
  assert.equal(context.status, 'succeeded');
  assert.equal(context.state.output, result);
  assert.equal(records.record(context.id).status, 'running');
  assert.equal(records.snapshot(execution).events.filter((event) => event.callId === records.record(context.id).id).length, 1);
  // The child is finished in the live scope. Only recording rejects its unfinished child record.
  assert.throws(() => root.succeed(execution, {}), /active operations/);
  assert.equal(execution.status, 'succeeded');
  assert.equal(records.hasOutcome(execution), false);
});

test('Work and failure-registration errors remain distinct; Context keeps the original thrown value', async (t) => {
  const records = recorder(),
    runtime = new Runtime(records);
  const failure = { reason: 'work failed' },
    registration = new Error('record unavailable');
  t.mock.method(records, 'finish', () => {
    throw registration;
  });
  let execution;
  await assert.rejects(
    invoke(runtime.execution(options), (context) => {
      execution = context;
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, registration]);
      assert.equal(error.cause, failure);
      return true;
    },
  );
  assert.equal(execution.status, 'failed');
  assert.equal(execution.state.error, failure);
  assert.equal(records.record(execution.id).status, 'running');
});

test('Failed begin prevents work and releases the live parent scope', async (t) => {
  const records = recorder(),
    runtime = new Runtime(records),
    root = runtime.execution(options),
    execution = root.begin();
  const failure = new Error('cannot record start');
  let child,
    entered = false;
  t.mock.method(records, 'beginOperation', (context) => {
    child = context;
    throw failure;
  });
  await assert.rejects(
    invoke(runtime.operation(execution, declaration, {}), () => {
      entered = true;
      return {};
    }),
    (error) => error === failure,
  );
  assert.equal(entered, false);
  assert.equal(child.state.error, failure);
  root.succeed(execution, {});
  assert.equal(execution.status, 'succeeded');
  assert.equal(records.hasOutcome(execution), true);
});

test('Runtime resolves execution ownership for nested operations and attempts without consulting records', async () => {
  const runtime = new Runtime(),
    foreign = new Runtime();
  let attempt, child, execution;
  const operation = new TestOperation(
    runtime,
    { name: 'owned', label: 'owned', source: 'test', phaseSource: 'test' },
    {
      before(input, context) {
        attempt = context;
        assert.equal(runtime.getExecutionContext(context), execution);
        assert.equal(runtime.getOperationContext(context).id, context.operationId);
        assert.equal(runtime.getExecutionContext(runtime.getOperationContext(context)), execution);
        assert.equal(Object.hasOwn(context, 'settings'), false);
        return input;
      },
      commit: (input) => input,
      after: (input) => input,
    },
  );
  await invoke(runtime.execution({ input: 'root', settings: {} }), (root) => {
    execution = root;
    return invoke(runtime.operation(root, declaration, 'nested'), (parent) => {
      child = parent;
      return operation.call(root, 'work', parent);
    });
  });
  assert.equal(runtime.getExecutionContext(attempt), execution);
  assert.equal(runtime.getExecutionContext(child), execution);
  assert.throws(() => foreign.getExecutionContext(attempt), /does not belong/);
  assert.throws(() => foreign.getOperationContext(attempt), /does not belong/);
  assert.equal(runtime.recorder, undefined);
});
