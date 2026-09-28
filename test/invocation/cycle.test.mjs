import { lifecycleFor } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Execution, Operation, Attempt, Runtime, RuntimeRecorder, RecordBook, RecordIndex, RuntimeError } from '@capix-observer/runtime';

import { validateSnapshot } from '@capix-observer/protocol';
import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';
import { TestOperation } from '../fixtures/operation.mjs';

const settings = {};
function fixture(recorded = true) {
  const recorder = recorded ? new RuntimeRecorder(new RecordBook(), new RecordIndex((r) => r.executionId), new RecordIndex((r) => r.operationId), new RecordIndex((r) => r.executionId)) : undefined;
  const runtime = new Runtime({ recorder: recorder });
  const lifecycle = lifecycleFor(runtime).execution({ input: 'root', settings });
  const execution = lifecycle.begin();
  return { runtime, recorder, execution, lifecycle };
}
class LocalOperation extends Operation {
  name = 'local';
  label = '本地处理';
  source = 'test/invocation/cycle.test.mjs';
  contexts = [];
  execute(context) {
    this.contexts.push(context);
    return context.currentInput + 1;
  }
}

test('local two-round handling keeps one context and one record with immutable process snapshots', async () => {
  const { runtime, recorder, execution, lifecycle } = fixture();
  const published = [];
  recorder.subscribe((snapshot) => {
    validateSnapshot(snapshot);
    published.push(snapshot);
  });
  class Advance extends LocalOperation {
    maxRounds = 2;
    execute(context) {
      this.contexts.push(context);
      context.currentInput.value++;
      return { value: context.currentInput.value };
    }
    receive(context, result) {
      assert.equal(context.status, 'running');
      return result.output.value < 2 ? context.continueWith(result.output, '补足到二') : result.output;
    }
  }
  const operation = new Advance(runtime),
    input = { value: 0 };
  const output = await operation.call(execution, input);
  assert.deepEqual(output, { value: 2 });
  assert.equal(operation.contexts[0], operation.contexts[1]);
  assert.equal(operation.contexts[0].input, input);
  assert.equal(operation.contexts[0].progress.round, 2);
  const record = recorder.record(operation.contexts[0].id);
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
  const snapshot = recorder.snapshot(execution);
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.events.length, 4);
  assert.equal(projectExecution(snapshot).nodes.find((n) => n.id === record.id).processes, record.value.processes);
});

test('execution, operation and attempt use the same paired entry/return protocol', async () => {
  for (const Base of [Execution, Operation, Attempt]) {
    const { runtime, recorder, execution } = fixture();
    class Local extends Base {
      name = 'local';
      label = 'local';
      source = 'test';
      callee = 'processing';
      maxRounds = 2;
      contexts = [];
      execute(context) {
        this.contexts.push(context);
        return context.currentInput + 1;
      }
      receive(context, result) {
        return result.output < 2 ? context.continueWith(result.output, '继续累加') : result.output * 10;
      }
    }
    const work = new Local(runtime);
    let output;
    if (Base === Execution) output = await work.call(0, { settings });
    else if (Base === Operation) output = await work.call(execution, 0);
    else {
      const parent = lifecycleFor(runtime).operation(execution, new TestOperation(runtime), 'parent').begin();
      output = await work.call(parent, 0);
    }
    assert.equal(output, 20);
    assert.equal(work.contexts[0], work.contexts[1]);
    assert.equal(recorder.record(work.contexts[0].id).value.processes.at(-1).output, 20);
  }
});

test('unhandled failure executes once and keeps the original error', async () => {
  const { runtime, recorder, execution } = fixture();
  const failure = new Error('invalid');
  class Fail extends LocalOperation {
    execute(context) {
      this.contexts.push(context);
      throw failure;
    }
  }
  const work = new Fail(runtime);
  await assert.rejects(work.call(execution, 0), (error) => error === failure);
  assert.equal(work.contexts.length, 1);
  const record = recorder.record(work.contexts[0].id);
  assert.deepEqual(
    record.value.processes.map((p) => p.type),
    ['start', 'throw', 'throw'],
  );
  assert.equal(work.contexts[0].state.error, failure);
});

test('default limit is one total round and explicit local handling is capped at two', async () => {
  for (const limit of [1, 2]) {
    const { runtime, recorder, execution } = fixture();
    class Repeat extends LocalOperation {
      maxRounds = limit;
      receive(context, result) {
        return context.continueWith(result.output, '仍未满足要求');
      }
    }
    const work = new Repeat(runtime);
    await assert.rejects(work.call(execution, 0), (e) => e.code === 'LOCAL_ROUND_LIMIT');
    assert.equal(work.contexts.length, limit);
    const context = work.contexts[0],
      record = recorder.record(context.id);
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
    const work = new Invalid(runtime);
    await assert.rejects(work.call(execution, 0), (e) => e.code === 'INVALID_ROUND_LIMIT');
    assert.equal(work.contexts.length, 0);
  }
  const { runtime, execution } = fixture();
  class InvalidReason extends LocalOperation {
    maxRounds = 2;
    receive(context, result) {
      return context.continueWith(result.output, ' ');
    }
  }
  const work = new InvalidReason(runtime);
  await assert.rejects(work.call(execution, 0), (e) => e.code === 'INVALID_CONTINUATION');
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
      receive(context, result) {
        controller.abort(cause);
        return context.continueWith(result.output, '下一轮');
      }
    }
    if (initiallyCancelled) controller.abort(cause);
    const work = new Repeat(runtime);
    await assert.rejects(work.call(execution, 0), (e) => e.code === 'INVOCATION_CANCELLED' && e.cause === cause);
    assert.equal(work.contexts.length, initiallyCancelled ? 0 : 1);
    const record = recorder.snapshot(execution).operations[0];
    assert.equal(record.value.processes.at(-1).type, 'stop');
    assert.equal(record.value.processes.at(-1).round, initiallyCancelled ? 0 : 1);
  }
});

test('receiver exceptions stop locally and retain the execution result and receiver error', async () => {
  const { runtime, recorder, execution } = fixture();
  const failure = new Error('receiver bug');
  class Broken extends LocalOperation {
    maxRounds = 2;
    receive() {
      throw failure;
    }
  }
  const work = new Broken(runtime);
  await assert.rejects(work.call(execution, 0), (e) => e.code === 'RECEIVE_FAILED' && e.cause === failure);
  assert.equal(work.contexts.length, 1);
  assert.equal(work.contexts[0].progress.result.output, 1);
  const record = recorder.record(work.contexts[0].id);
  assert.equal(record.value.processes[2].error.message, 'receiver bug');
  assert.equal(record.value.processes.at(-1).error.code, 'RECEIVE_FAILED');
});

test('a parent may handle a failed child without rewriting the failed child invocation', async () => {
  const { runtime, recorder, execution, lifecycle } = fixture();
  class Child extends Attempt {
    name = 'child';
    label = 'child';
    source = 'test';
    callee = 'processing';
    execute(context) {
      if (context.currentInput === 0) throw new RuntimeError('REJECTED', 'zero');
      return context.currentInput;
    }
  }
  const child = new Child(runtime);
  class Parent extends LocalOperation {
    maxRounds = 2;
    execute(context) {
      this.contexts.push(context);
      return child.call(context, context.currentInput);
    }
    receive(context, result) {
      if (result.status === 'failed') return context.continueWith(1, '改正输入');
      return result.output;
    }
  }
  const work = new Parent(runtime);
  assert.equal(await work.call(execution, 0), 1);
  lifecycle.succeed(execution, 1);
  const snapshot = recorder.snapshot(execution);
  validateSnapshot(snapshot);
  assert.deepEqual(
    snapshot.attempts.map((a) => a.status),
    ['failed', 'succeeded'],
  );
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.operations[0].value.processes[1].type, 'throw');
});

test('record failure bypasses local recovery and prevents repeating successful work', async () => {
  const { runtime, recorder, execution } = fixture();
  const original = recorder.process.bind(recorder);
  const failure = new Error('write failed');
  recorder.process = (context, process) => {
    if (process.stage === 'execute' && process.type === 'return') throw failure;
    original(context, process);
  };
  let received = 0;
  class Repeat extends LocalOperation {
    maxRounds = 2;
    receive(context, result) {
      received++;
      return context.continueWith(0, 'retry');
    }
  }
  const work = new Repeat(runtime);
  await assert.rejects(work.call(execution, 0), (e) => e.code === 'RECORDING_FAILED' && e.cause === failure);
  assert.equal(work.contexts.length, 1);
  assert.equal(received, 0);
  assert.equal(work.contexts[0].progress.result.output, 1);
});

test('work failure and failed process registration preserve both errors', async () => {
  const { runtime, recorder, execution } = fixture();
  const original = recorder.process.bind(recorder),
    failure = new Error('work'),
    registration = new Error('record');
  recorder.process = (context, process) => {
    if (process.type === 'throw') throw registration;
    original(context, process);
  };
  class Fail extends LocalOperation {
    execute() {
      throw failure;
    }
  }
  await assert.rejects(new Fail(runtime).call(execution, 0), (e) => e instanceof AggregateError && e.errors[0] === failure && e.errors[1].cause === registration);
});

test('no recorder is required by local handling; live input/output keep their identities', async () => {
  const { runtime, execution } = fixture(false);
  const initial = new Map([['value', 0]]),
    next = new Map([['value', 1]]);
  class Local extends LocalOperation {
    maxRounds = 2;
    execute(context) {
      this.contexts.push(context);
      return context.currentInput;
    }
    receive(context, result) {
      return result.output === initial ? context.continueWith(next, 'next') : result.output;
    }
  }
  const work = new Local(runtime);
  assert.equal(await work.call(execution, initial), next);
  assert.equal(work.contexts[0].input, initial);
  assert.equal(work.contexts[0].currentInput, next);
});

test('child recording failures cannot be converted into parent retries', async () => {
  const { runtime, recorder, execution } = fixture();
  let effects = 0,
    receptions = 0;
  const original = recorder.process.bind(recorder);
  recorder.process = (context, process) => {
    if ('operationContext' in context && process.type === 'return') throw new Error('child recording failed');
    original(context, process);
  };
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
  const child = new Child(runtime);
  class Parent extends LocalOperation {
    maxRounds = 2;
    execute(context) {
      return child.call(context, 0);
    }
    receive(context) {
      receptions++;
      return context.continueWith(0, 'retry');
    }
  }
  await assert.rejects(new Parent(runtime).call(execution, 0), (e) => e.code === 'RECORDING_FAILED');
  assert.equal(effects, 1);
  assert.equal(receptions, 0);
});

test('process publication is live during receive and does not create standalone records', async () => {
  const { runtime, recorder, execution } = fixture();
  let resume;
  class Waiting extends LocalOperation {
    receive(_context, result) {
      return new Promise((resolve) => {
        resume = () => resolve(result.output);
      });
    }
  }
  const work = new Waiting(runtime),
    pending = work.call(execution, 0);
  while (!resume) await new Promise((resolve) => setImmediate(resolve));
  const snapshot = recorder.snapshot(execution),
    record = snapshot.operations[0];
  assert.equal(record.status, 'running');
  assert.deepEqual(
    record.value.processes.map((p) => p.type),
    ['start', 'return'],
  );
  assert.equal(work.contexts[0].progress.phase, 'receive');
  assert.equal([...recorder.book.values()].length, 4); // root/op and their two call events
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
  await assert.rejects(new Fail(runtime).call(execution, 0), (error) => error === failure);
});
