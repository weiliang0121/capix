import { Execution, Operation, Attempt } from '../fixtures/behavior.mjs';
import { callFor, recordFor, rememberCall } from '../fixtures/lifecycle.mjs';
import { InvocationRecord, AttemptRecord } from '@capix-observer/runtime';
import { subscribeExecutions } from '@capix-observer/service';
import { ExecutionRecordHelper } from '@capix-observer/runtime';
import { lifecycleFor } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, Recorder, RecordBook, ExceptionContract, createRuntime } from '@capix-observer/runtime';

import { validateSnapshot } from '@capix-observer/protocol';
import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';
import { TestOperation } from '../fixtures/operation.mjs';

const settings = {};
function fixture(recorded = true) {
  const recorder = recorded ? new Recorder(new RecordBook()) : undefined;
  const runtime = createRuntime({ recorder });
  const lifecycle = lifecycleFor(runtime).execution({ input: 'root', settings });
  const execution = lifecycle.begin();
  return { runtime, recorder, execution, lifecycle };
}
class LocalOperation extends Operation {
  name = 'local';
  label = '本地处理';
  source = 'test/invocation/cycle.test.mjs';
  contexts = [];
  execute(context, invocation) {
    rememberCall(invocation);
    this.contexts.push(context);
    return context.currentInput + 1;
  }
}

test('local two-round handling keeps one context and one record with immutable process snapshots', async () => {
  const { runtime, recorder, execution, lifecycle } = fixture();
  const published = [];
  subscribeExecutions(runtime.recording, (snapshot) => {
    validateSnapshot(snapshot);
    published.push(snapshot);
  });
  class Advance extends LocalOperation {
    maxRounds = 2;
    execute(context, invocation) {
      rememberCall(invocation);
      this.contexts.push(context);
      context.currentInput.value++;
      return { value: context.currentInput.value };
    }
    accept(context, output) {
      assert.equal(context.status, 'running');
      return output.value < 2 ? context.continueWith(output, '补足到二') : output;
    }
  }
  const operation = new Advance(runtime.operationInvocations),
    input = { value: 0 };
  const output = await operation.call(callFor(execution), input);
  assert.deepEqual(output, { value: 2 });
  assert.equal(operation.contexts[0], operation.contexts[1]);
  assert.equal(operation.contexts[0].input, input);
  assert.equal(operation.contexts[0].progress.round, 2);
  const record = recordFor(operation.contexts[0]);
  assert.deepEqual(record.value.input, { value: 0 });
  assert.equal(record.value.processes.length, 6);
  assert.deepEqual(
    record.value.processes.map((p) => [p.round, p.stage, p.type]),
    [
      [1, 'execute', 'start'],
      [1, 'execute', 'return'],
      [1, 'receive', 'continue'],
      [2, 'execute', 'start'],
      [2, 'execute', 'return'],
      [2, 'receive', 'return'],
    ],
  );
  assert.equal(record.value.processes[1].output.value, 1);
  assert.equal(record.value.processes[2].input.value, 1);
  assert.equal(record.value.processes[3].input.value, 1);
  assert.equal(published.find((s) => s.operations[0]?.value.processes.length === 1).operations[0].value.processes.length, 1);
  assert.throws(() => record.value.processes.push({}), TypeError);
  assert.throws(() => (record.value.processes[1].output.value = 100), TypeError);
  assert.throws(() => record.append(record.value.processes[0]), /ended/);
  lifecycle.succeed(execution, output);
  const snapshot = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.events.length, 4);
  assert.equal(projectExecution(snapshot).nodes.find((n) => n.id === record.id).processes, record.value.processes);
});

test('EOA binds inherited execute and acceptance methods to each behavior instance', async () => {
  for (const Base of [Execution, Operation, Attempt]) {
    const { runtime, recorder, execution } = fixture();
    class Local extends Base {
      name = 'local';
      label = 'local';
      source = 'test';
      callee = 'processing';
      maxRounds = 2;
      contexts = [];
      multiplier = 10;
      receptions = 0;
      execute(context, invocation) {
        rememberCall(invocation);
        this.contexts.push(context);
        return context.currentInput + 1;
      }
      accept(context, output) {
        this.receptions++;
        return output < 2 ? context.continueWith(output, '继续累加') : output * this.multiplier;
      }
    }
    class Inherited extends Local {}
    const work = new Inherited(Base === Execution ? runtime.executionInvocations : Base === Operation ? runtime.operationInvocations : runtime.attemptInvocations);
    let output;
    if (Base === Execution) output = await work.call(0, { settings });
    else if (Base === Operation) output = await work.call(callFor(execution), 0);
    else {
      const parent = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), 'parent').begin();
      output = await work.call(callFor(parent), 0);
    }
    assert.equal(output, 20);
    assert.equal(work.receptions, 2);
    assert.equal(work.contexts[0], work.contexts[1]);
    assert.equal(recordFor(work.contexts[0]).value.processes.at(-1).output, 20);
  }
});

test('unhandled failure executes once and keeps the original error', async () => {
  const { runtime, recorder, execution } = fixture();
  const failure = new Error('invalid');
  class Fail extends LocalOperation {
    execute(context, invocation) {
      rememberCall(invocation);
      this.contexts.push(context);
      throw failure;
    }
  }
  const work = new Fail(runtime.operationInvocations);
  await assert.rejects(work.call(callFor(execution), 0), (error) => error === failure);
  assert.equal(work.contexts.length, 1);
  const record = recordFor(work.contexts[0]);
  assert.deepEqual(
    record.value.processes.map((p) => p.type),
    ['start', 'throw'],
  );
  assert.equal(work.contexts[0].state.error, failure);
});

test('default limit is one total round and explicit local handling is capped at two', async () => {
  for (const limit of [1, 2]) {
    const { runtime, recorder, execution } = fixture();
    class Repeat extends LocalOperation {
      maxRounds = limit;
      accept(context, output) {
        return context.continueWith(output, '仍未满足要求');
      }
    }
    const work = new Repeat(runtime.operationInvocations);
    await assert.rejects(work.call(callFor(execution), 0), (e) => e.code === 'LOCAL_ROUND_LIMIT');
    assert.equal(work.contexts.length, limit);
    const context = work.contexts[0],
      record = recordFor(context);
    assert.equal(context.progress.result.output, limit);
    assert.equal(context.status, 'failed');
    assert.equal(record.value.processes.at(-1).type, 'stop');
    assert.equal(record.value.processes.at(-1).error.code, 'LOCAL_ROUND_LIMIT');
    assert.equal(record.value.processes.at(-2).reason, '仍未满足要求');
  }
});

test('invalid limits and empty continuation reasons stop explicitly', async () => {
  for (const limit of [0, 3, Infinity, 1.5]) {
    const { runtime, execution } = fixture();
    class Invalid extends LocalOperation {
      maxRounds = limit;
    }
    const work = new Invalid(runtime.operationInvocations);
    await assert.rejects(work.call(callFor(execution), 0), (e) => e.code === 'INVALID_ROUND_LIMIT');
    assert.equal(work.contexts.length, 0);
  }
  const { runtime, execution } = fixture();
  class InvalidReason extends LocalOperation {
    maxRounds = 2;
    accept(context, output) {
      return context.continueWith(output, ' ');
    }
  }
  const work = new InvalidReason(runtime.operationInvocations);
  await assert.rejects(work.call(callFor(execution), 0), (e) => e.code === 'INVALID_CONTINUATION');
  assert.equal(work.contexts.length, 1);
});

test('cancelled calls do not enter execute; cancellation between rounds keeps the first result', async () => {
  for (const initiallyCancelled of [true, false]) {
    const { runtime, recorder } = fixture();
    const controller = new AbortController();
    const execution = lifecycleFor(runtime).execution({ input: 'root', settings, signal: controller.signal }).begin();
    const cause = new Error('cancel');
    class Repeat extends LocalOperation {
      maxRounds = 2;
      accept(context, output) {
        controller.abort(cause);
        return context.continueWith(output, '下一轮');
      }
    }
    if (initiallyCancelled) controller.abort(cause);
    const work = new Repeat(runtime.operationInvocations);
    await assert.rejects(work.call(callFor(execution), 0), (e) => e.code === 'INVOCATION_CANCELLED' && e.cause === cause);
    assert.equal(work.contexts.length, initiallyCancelled ? 0 : 1);
    const record = ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).operations[0];
    assert.equal(record.value.processes.at(-1).type, 'stop');
    assert.equal(record.value.processes.at(-1).round, initiallyCancelled ? 0 : 1);
  }
});

test('acceptance errors stop locally and retain the execution result and original error', async () => {
  const { runtime, recorder, execution } = fixture();
  const failure = new Error('receiver bug');
  class Broken extends LocalOperation {
    maxRounds = 2;
    accept() {
      throw failure;
    }
  }
  const work = new Broken(runtime.operationInvocations);
  await assert.rejects(work.call(callFor(execution), 0), (error) => error === failure);
  assert.equal(work.contexts.length, 1);
  assert.equal(work.contexts[0].progress.result.output, 1);
  const record = recordFor(work.contexts[0]);
  assert.equal(record.value.processes[2].error.message, 'receiver bug');
  assert.equal(record.value.processes.at(-1).failure.kind, 'error');
  assert.equal(record.value.processes.at(-1).failure.phase, 'receive');
});

test('a parent may handle a failed child without rewriting the failed child invocation', async () => {
  const { runtime, recorder, execution, lifecycle } = fixture();
  const rejected = new ExceptionContract('test.child-rejected');
  class Child extends Attempt {
    raises = [rejected];
    name = 'child';
    label = 'child';
    source = 'test';
    callee = 'processing';
    execute(context, invocation) {
      rememberCall(invocation);
      if (context.currentInput === 0) throw rejected.create('zero', { input: 0 });
      return context.currentInput;
    }
  }
  const child = new Child(runtime.attemptInvocations);
  class Parent extends LocalOperation {
    maxRounds = 2;
    execute(context, invocation) {
      rememberCall(invocation);
      this.contexts.push(context);
      return child.call(invocation, context.currentInput);
    }
    exceptions = {
      accepts: [rejected],
      handle() {
        return { kind: 'continue', input: 1, reason: '改正输入' };
      },
    };
  }
  const work = new Parent(runtime.operationInvocations);
  assert.equal(await work.call(callFor(execution), 0), 1);
  lifecycle.succeed(execution, 1);
  const snapshot = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
  validateSnapshot(snapshot);
  assert.deepEqual(
    snapshot.attempts.map((a) => a.status),
    ['failed', 'succeeded'],
  );
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.operations[0].value.processes[1].type, 'throw');
});

test('record failure bypasses local recovery and prevents repeating successful work', async (t) => {
  const { runtime, recorder, execution } = fixture();
  const original = InvocationRecord.prototype.append;
  const failure = new Error('write failed');
  t.mock.method(InvocationRecord.prototype, 'append', function (process) {
    if (process.stage === 'execute' && process.type === 'return') throw failure;
    original.call(this, process);
  });
  let received = 0;
  class Repeat extends LocalOperation {
    maxRounds = 2;
    accept(context, output) {
      received++;
      return context.continueWith(0, 'retry');
    }
  }
  const work = new Repeat(runtime.operationInvocations);
  await assert.rejects(work.call(callFor(execution), 0), (e) => e.code === 'RECORDING_FAILED' && e.cause === failure);
  assert.equal(work.contexts.length, 1);
  assert.equal(received, 0);
  assert.equal(work.contexts[0].progress.result.output, 1);
});

test('work failure and failed process registration preserve both errors', async (t) => {
  const { runtime, recorder, execution } = fixture();
  const original = InvocationRecord.prototype.append,
    failure = new Error('work'),
    registration = new Error('record');
  t.mock.method(InvocationRecord.prototype, 'append', function (process) {
    if (process.type === 'throw') throw registration;
    original.call(this, process);
  });
  class Fail extends LocalOperation {
    execute() {
      throw failure;
    }
  }
  await assert.rejects(new Fail(runtime.operationInvocations).call(callFor(execution), 0), (e) => e instanceof AggregateError && e.errors[0] === failure && e.errors[1].cause === registration);
});

test('no recorder is required by local handling; live input/output keep their identities', async () => {
  const { runtime, execution } = fixture(false);
  const initial = new Map([['value', 0]]),
    next = new Map([['value', 1]]);
  class Local extends LocalOperation {
    maxRounds = 2;
    execute(context, invocation) {
      rememberCall(invocation);
      this.contexts.push(context);
      return context.currentInput;
    }
    accept(context, output) {
      return output === initial ? context.continueWith(next, 'next') : output;
    }
  }
  const work = new Local(runtime.operationInvocations);
  assert.equal(await work.call(callFor(execution), initial), next);
  assert.equal(work.contexts[0].input, initial);
  assert.equal(work.contexts[0].currentInput, next);
});

test('child recording failures cannot be converted into parent retries', async (t) => {
  const { runtime, recorder, execution } = fixture();
  let effects = 0,
    receptions = 0;
  const original = InvocationRecord.prototype.append;
  t.mock.method(InvocationRecord.prototype, 'append', function (process) {
    if (this instanceof AttemptRecord && process.type === 'return') throw new Error('child recording failed');
    original.call(this, process);
  });
  class Child extends Attempt {
    name = 'child';
    label = 'child';
    source = 'test';
    callee = 'processing';
    execute() {
      effects++;
      return 'done';
    }
  }
  const child = new Child(runtime.attemptInvocations);
  class Parent extends LocalOperation {
    maxRounds = 2;
    execute(context, invocation) {
      rememberCall(invocation);
      return child.call(invocation, 0);
    }
    accept(context) {
      receptions++;
      return context.continueWith(0, 'retry');
    }
  }
  await assert.rejects(new Parent(runtime.operationInvocations).call(callFor(execution), 0), (e) => e.code === 'RECORDING_FAILED');
  assert.equal(effects, 1);
  assert.equal(receptions, 0);
});

test('process publication is live during acceptance and does not create standalone records', async () => {
  const { runtime, recorder, execution } = fixture();
  let resume;
  class Waiting extends LocalOperation {
    accept(_context, output) {
      return new Promise((resolve) => {
        resume = () => resolve(output);
      });
    }
  }
  const work = new Waiting(runtime.operationInvocations),
    pending = work.call(callFor(execution), 0);
  while (!resume) await new Promise((resolve) => setImmediate(resolve));
  const snapshot = ExecutionRecordHelper.observe(runtime.recording, callFor(execution)),
    record = snapshot.operations[0];
  assert.equal(record.status, 'running');
  assert.deepEqual(
    record.value.processes.map((p) => p.type),
    ['start', 'return'],
  );
  assert.equal(work.contexts[0].progress.phase, 'receive');
  assert.equal([...recorder.book.values()].length, 5); // Runtime, root/op and their two call events
  validateSnapshot(snapshot);
  const corrupt = structuredClone(snapshot);
  corrupt.operations[0].value.processes[0].sequence = 9;
  assert.throws(() => validateSnapshot(corrupt));
  resume();
  assert.equal(await pending, 1);
  assert.equal(record.value.processes.length, 2);
});

test('a cyclic aggregate remains a work error rather than recursing in control classification', async () => {
  const { runtime, execution } = fixture(false);
  const failure = new AggregateError([], 'cyclic failure');
  failure.errors.push(failure);
  class Fail extends LocalOperation {
    execute() {
      throw failure;
    }
  }
  await assert.rejects(new Fail(runtime.operationInvocations).call(callFor(execution), 0), (error) => error === failure);
});
