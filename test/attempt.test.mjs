import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attempt, AttemptContext, Runtime, RuntimeRecorder, RecordBook, RecordIndex, Operation } from '@capix-observer/runtime';

import { TestOperation } from './fixtures/operation.mjs';

import { TestAttempt } from './fixtures/attempt.mjs';
import { validateSnapshot } from '@capix-observer/protocol';

function recordedRuntime() {
  return new Runtime({ recorder: new RuntimeRecorder(new RecordBook(), new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), new RecordIndex((record) => record.executionId)) });
}

test('one Attempt instance creates independent contexts per call and leaves parent work running after failure', async () => {
  const runtime = recordedRuntime();
  const contexts = [];
  const failure = new Error('rejected input');
  class AcceptText extends Attempt {
    name = 'acceptText';
    label = '接纳文本';
    source = 'test/attempt.test.mjs · AcceptText';
    callee = 'processing';
    execute(context) {
      contexts.push(context);
      if (context.input === 'invalid') throw failure;
      return context.input;
    }
  }
  const attempt = new AcceptText(runtime);
  const executionLifecycle = lifecycleFor(runtime).execution({ input: 'input', settings: {} });
  const execution = executionLifecycle.begin();
  const operationLifecycle = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), 'input');
  const operation = operationLifecycle.begin();

  await assert.rejects(attempt.call(operation, 'invalid'), (error) => error === failure);
  assert.equal(operation.status, 'running');
  assert.equal(await attempt.call(operation, 'accepted'), 'accepted');
  assert.ok(contexts.every((context) => context instanceof AttemptContext && context.operationContext === operation));
  assert.notEqual(contexts[0].id, contexts[1].id);
  assert.equal(contexts[0].state.error, failure);
  assert.equal(contexts[1].state.output, 'accepted');
  const records = runtime.recorder.snapshot(execution).attempts;
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
  await assert.rejects(attempt.call(operation, 'too late'), /ended/);
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
  assert.ok(Object.values(attempts).every((attempt) => attempt instanceof Attempt));
  assert.equal(new Set(Object.values(attempts)).size, 3);
  const executions = [];
  for (const input of [1, 4]) {
    const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (context) => {
      executions.push(context);
      return operation.call(context, input);
    });
    assert.equal(output, String((input + 1) * 2));
    assert.equal(operation.actions, attempts);
  }
  assert.equal(new Set(seen.map((context) => context.id)).size, 6);
  assert.ok(seen.every((context) => !Object.hasOwn(context, 'name')));
  for (const execution of executions) {
    const snapshot = runtime.recorder.snapshot(execution);
    assert.equal(snapshot.operations.length, 1);
    assert.equal(snapshot.attempts.length, 3);
    assert.deepEqual(
      snapshot.attempts.map((attempt) => attempt.name),
      ['load', 'transform', 'accept'],
    );
    assert.equal(snapshot.events.length, 10);
  }
});

test('Attempt works without a recorder and preserves non-JSON input and output identity', async () => {
  const runtime = new Runtime();
  const contexts = [];
  class Identity extends Attempt {
    name = 'identity';
    label = '原样返回';
    source = 'test/attempt.test.mjs · Identity';
    callee = 'processing';
    execute(context) {
      contexts.push(context);
      return context.input;
    }
  }
  const input = new Map([['content', 'original']]);
  const operation = new TestOperation(runtime);
  const attempt = new Identity(runtime);
  const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (execution) => invoke(lifecycleFor(runtime).operation(execution, operation, input), (context) => attempt.call(context, input)));
  assert.equal(output, input);
  assert.equal(contexts[0].input, input);
  assert.equal(contexts[0].state.output, input);
});

test('operations can organize any number of named actions without a fixed stage vocabulary', async () => {
  for (const count of [1, 2, 5]) {
    const runtime = recordedRuntime();
    const names = Array.from({ length: count }, (_, index) => `action${index}`);
    const operation = new TestOperation(runtime, Object.fromEntries(names.map((name) => [name, (value) => [...value, name]])));
    let context;
    const output = await invoke(lifecycleFor(runtime).execution({ input: [], settings: {} }), (execution) => {
      context = execution;
      return operation.call(execution, []);
    });
    assert.deepEqual(output, names);
    const snapshot = runtime.recorder.snapshot(context);
    validateSnapshot(snapshot);
    assert.deepEqual(
      snapshot.attempts.map((attempt) => attempt.name),
      names,
    );
    assert.equal(snapshot.events.length, 2 * (2 + count));
  }
});

test('the operation owns branching and can explicitly call the same action twice without child attempts', async () => {
  const runtime = recordedRuntime();
  class Increment extends Operation {
    name = 'increment';
    label = '按需递增';
    source = 'test/attempt.test.mjs · Increment';
    add = new TestAttempt(runtime, 'addOne', (input) => input + 1);
    async execute(context) {
      const output = await this.add.call(context, context.input);
      return output < 2 ? this.add.call(context, output) : output;
    }
  }
  const operation = new Increment(runtime);
  for (const input of [0, 2]) {
    let context;
    const output = await invoke(lifecycleFor(runtime).execution({ input, settings: {} }), (execution) => {
      context = execution;
      return operation.call(execution, input);
    });
    assert.equal(output, input === 0 ? 2 : 3);
    const snapshot = runtime.recorder.snapshot(context);
    validateSnapshot(snapshot);
    assert.equal(snapshot.attempts.length, input === 0 ? 2 : 1);
    assert.ok(snapshot.attempts.every((attempt) => attempt.name === 'addOne' && attempt.operationId === snapshot.operations[0].id));
    assert.equal(new Set(snapshot.attempts.map((attempt) => attempt.contextId)).size, snapshot.attempts.length);
  }
});
