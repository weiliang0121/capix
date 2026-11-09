import { AttemptFixture, OperationFixture } from './fixtures/behavior.mjs';
import { callFor, rememberCall } from './fixtures/lifecycle.mjs';
import { ChildCallFailure } from '@weiliang0121/capix-runtime';
import { ExecutionRecordHelper } from '@weiliang0121/capix-records';
import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallableContext, ExceptionContract } from '@weiliang0121/capix-runtime';
import { Recorder, RecordBook } from '@weiliang0121/capix-records';
import { createBoundRuntime, observeCall } from './fixtures/runtime.mjs';

import { TestOperation } from './fixtures/operation.mjs';

import { TestAttempt } from './fixtures/attempt.mjs';
import { validateExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';

function recordedRuntime() {
  return createBoundRuntime({ recorder: new Recorder(new RecordBook()) });
}

test('one Attempt instance creates independent contexts per call and leaves parent work running after failure', async () => {
  const runtime = recordedRuntime();
  const contexts = [];
  const rejection = new ExceptionContract('REJECTED_INPUT');
  const failure = rejection.create('rejected input', {});
  class AcceptText extends AttemptFixture {
    name = 'acceptText';
    label = '接纳文本';
    source = 'test/attempt.test.mjs · AcceptText';
    execute(context, invocation) {
      rememberCall(invocation);
      contexts.push(context);
      if (context.input === 'invalid') throw failure;
      return context.input;
    }
  }
  const attempt = new AcceptText(runtime.attemptInvocationBuilder);
  const executionLifecycle = lifecycleFor(runtime).execution({ input: 'input', settings: {} });
  const execution = executionLifecycle.begin();
  const operationLifecycle = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), 'input');
  const operation = operationLifecycle.begin();

  await assert.rejects(attempt.call(callFor(operation), 'invalid'), (error) => error instanceof ChildCallFailure && error.exception === failure);
  assert.equal(operation.status, 'running');
  assert.equal(await attempt.call(callFor(operation), 'accepted'), 'accepted');
  assert.ok(contexts.every((context) => context instanceof CallableContext && context.signal === operation.signal && context.operationContext === undefined));
  assert.notEqual(contexts[0].id, contexts[1].id);
  assert.equal(contexts[0].state.error, failure);
  assert.equal(contexts[1].state.output, 'accepted');
  const records = observeCall(runtime.recording, callFor(execution)).attempts;
  assert.deepEqual(
    records.map((record) => record.status),
    ['failed', 'succeeded'],
  );
  assert.deepEqual(
    records.map((record) => record.contextId),
    contexts.map((context) => context.id),
  );
  assert.ok(records.every((record) => record.source === attempt.source && record.callee === attempt.callee));
  operationLifecycle.succeed(operation, 'accepted');
  await assert.rejects(attempt.call(callFor(operation), 'too late'), /ended/);
  assert.equal(contexts.length, 2);
  executionLifecycle.succeed(execution, 'accepted');
});

test('Operation reuses its three Attempt instances while keeping call contexts and records separate', async () => {
  const runtime = recordedRuntime();
  const seen = [];
  const operation = new TestOperation(runtime, {
    load: (input, context) => {
      seen.push(context);
      return input + 1;
    },
    transform: async (input, context) => {
      seen.push(context);
      return input * 2;
    },
    accept: (input, context) => {
      seen.push(context);
      return String(input);
    },
  });
  const attempts = operation.actions;
  assert.ok(Object.values(attempts).every((attempt) => attempt instanceof AttemptFixture));
  assert.equal(new Set(Object.values(attempts)).size, 3);
  const executions = [];
  for (const input of [1, 4]) {
    const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (context, invocation) => {
      executions.push(context);
      return operation.call(invocation, input);
    });
    assert.equal(output, String((input + 1) * 2));
    assert.equal(operation.actions, attempts);
  }
  assert.equal(new Set(seen.map((context) => context.id)).size, 6);
  assert.ok(seen.every((context) => !Object.hasOwn(context, 'name')));
  for (const execution of executions) {
    const snapshot = observeCall(runtime.recording, callFor(execution));
    assert.equal(snapshot.operations.length, 1);
    assert.equal(snapshot.attempts.length, 3);
    assert.deepEqual(
      snapshot.attempts.map((attempt) => attempt.name),
      ['load', 'transform', 'accept'],
    );
    assert.equal(snapshot.events.length, 10);
  }
});

test('Attempt works without a recorder and fixes ordinary data before child consumption', async () => {
  const runtime = createBoundRuntime();
  const contexts = [];
  class Identity extends AttemptFixture {
    name = 'identity';
    label = '原样返回';
    source = 'test/attempt.test.mjs · Identity';
    execute(context, invocation) {
      rememberCall(invocation);
      contexts.push(context);
      return context.input;
    }
  }
  const input = { content: 'original', absent: undefined, zero: -0 };
  const operation = new TestOperation(runtime);
  const attempt = new Identity(runtime.attemptInvocationBuilder);
  const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (execution) => invoke(lifecycleFor(runtime).operation(execution, operation, input), (context, invocation) => attempt.call(invocation, input)));
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.ok(Object.isFrozen(output));
  assert.deepEqual(contexts[0].input, input);
  assert.equal(contexts[0].state.output, output);
});

test('operations can organize any number of named actions without a fixed stage vocabulary', async () => {
  for (const count of [1, 2, 5]) {
    const runtime = recordedRuntime();
    const names = Array.from({ length: count }, (_, index) => `action${index}`);
    const operation = new TestOperation(runtime, Object.fromEntries(names.map((name) => [name, (value) => [...value, name]])));
    let context;
    const output = await invoke(lifecycleFor(runtime).execution({ input: [], settings: {} }), (execution) => {
      context = execution;
      return operation.call(callFor(execution), []);
    });
    assert.deepEqual(output, names);
    const snapshot = observeCall(runtime.recording, callFor(context));
    validateExecutionRecordSnapshot(snapshot);
    assert.deepEqual(
      snapshot.attempts.map((attempt) => attempt.name),
      names,
    );
    assert.equal(snapshot.events.length, 2 * (2 + count));
  }
});

test('the operation owns branching and can explicitly call the same action twice without child attempts', async () => {
  const runtime = recordedRuntime();
  class Increment extends OperationFixture {
    name = 'increment';
    label = '按需递增';
    source = 'test/attempt.test.mjs · Increment';
    add = new TestAttempt(runtime, 'addOne', (input) => input + 1);
    async execute(context, invocation) {
      rememberCall(invocation);
      const output = await this.add.call(invocation, context.input);
      return output < 2 ? this.add.call(invocation, output) : output;
    }
  }
  const operation = new Increment(runtime.operationInvocationBuilder);
  for (const input of [0, 2]) {
    let context;
    const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (execution) => {
      context = execution;
      return operation.call(callFor(execution), input);
    });
    assert.equal(output, input === 0 ? 2 : 3);
    const snapshot = observeCall(runtime.recording, callFor(context));
    validateExecutionRecordSnapshot(snapshot);
    assert.equal(snapshot.attempts.length, input === 0 ? 2 : 1);
    assert.ok(snapshot.attempts.every((attempt) => attempt.name === 'addOne' && attempt.parentId === snapshot.operations[0].id));
    assert.equal(new Set(snapshot.attempts.map((attempt) => attempt.contextId)).size, snapshot.attempts.length);
  }
});
