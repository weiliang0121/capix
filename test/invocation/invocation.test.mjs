import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@capix-observer/runtime';

const signal = () => new AbortController().signal;

test('separate Invocations can overlap without mixing contexts or outputs', async () => {
  const pending = new Map();
  const create = (input) => new Invocation({ context: new InvocationContext(input), work: { maxRounds: 1, execute: (context) => new Promise((resolve) => pending.set(context.input, resolve)) }, signal: signal() });
  const first = create('a');
  const second = create('b');
  const a = { answer: 'a' };
  const b = { answer: 'b' };
  const firstResult = first.run();
  const secondResult = second.run();
  pending.get('b')(b);
  assert.equal(await secondResult, b);
  assert.equal(first.context.status, 'running');
  pending.get('a')(a);
  assert.equal(await firstResult, a);
  assert.notEqual(first.context.id, second.context.id);
  assert.equal(first.context.state.output, a);
  assert.equal(second.context.state.output, b);
});

test('an ended context cannot start a new Invocation or write a start record', async () => {
  const context = new InvocationContext('input');
  context.complete('done');
  const invocation = new Invocation({ context, work: { maxRounds: 1, execute: () => assert.fail('must not run') }, signal: signal(), recording: { begin: () => assert.fail('must not register') } });
  await assert.rejects(invocation.run(), /ended/);
  assert.equal(context.state.output, 'done');
  await assert.rejects(invocation.run(), /already started/);
});

test('sync and async work failures keep their identity and finish their context once', async () => {
  const failure = new Error('work failed');
  for (const execute of [
    () => {
      throw failure;
    },
    async () => {
      throw failure;
    },
  ]) {
    const finished = [];
    const recorder = {
      begin(context, bind) {
        bind({ contextId: context.id });
      },
      process() {},
      finish(context) {
        finished.push(context);
      },
    };
    const invocation = new Invocation({ context: new InvocationContext('input'), work: { execute, maxRounds: 1 }, signal: signal(), recording: recorder });
    await assert.rejects(invocation.run(), (error) => error === failure);
    assert.equal(invocation.context.state.error, failure);
    assert.deepEqual(finished, [invocation.context]);
  }
});

test('successful invocation keeps its outcome when terminal registration throws', async () => {
  const failure = new Error('cannot finish record');
  let finishes = 0;
  const recorder = {
    begin(context, bind) {
      bind({ contextId: context.id });
    },
    process() {},
    finish() {
      finishes++;
      throw failure;
    },
  };
  const invocation = new Invocation({ context: new InvocationContext('input'), work: { execute: () => 'output', maxRounds: 1 }, signal: signal(), recording: recorder });
  await assert.rejects(invocation.run(), (error) => error.code === 'RECORDING_FAILED' && error.cause === failure);
  assert.deepEqual(invocation.context.state, { status: 'succeeded', output: 'output' });
  assert.equal(finishes, 1);
});

test('started runs after validation and before registration and work with the same live invocation', async () => {
  const order = [];
  const context = new InvocationContext('input');
  const invocation = new Invocation({
    context,
    signal: signal(),
    validate() {
      order.push('validate');
    },
    started(current, call) {
      assert.equal(current, context);
      assert.equal(call, invocation);
      assert.equal(call.record, undefined);
      assert.equal(current.progress.round, 0);
      order.push('started');
    },
    recording: {
      begin(current, bind) {
        order.push('register');
        bind({ contextId: current.id });
      },
      process() {},
      finish() {},
    },
    work: {
      maxRounds: 1,
      execute() {
        order.push('execute');
        return 'done';
      },
    },
  });
  assert.equal(await invocation.run(), 'done');
  assert.deepEqual(order, ['validate', 'started', 'register', 'execute']);
});

test('failed validation prevents started setup and record registration', async () => {
  const failure = new Error('invalid parent');
  const invocation = new Invocation({
    context: new InvocationContext('input'),
    signal: signal(),
    validate() {
      throw failure;
    },
    started: () => assert.fail('must not set up'),
    recording: { begin: () => assert.fail('must not register') },
    work: { maxRounds: 1, execute: () => assert.fail('must not execute') },
  });
  await assert.rejects(invocation.run(), (error) => error === failure);
  assert.equal(invocation.context.state.error, failure);
});
