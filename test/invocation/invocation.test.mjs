import { observeCall } from '../fixtures/observation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@capix/server-runtime';

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
  const invocation = new Invocation({
    context,
    work: { maxRounds: 1, execute: () => assert.fail('must not run') },
    signal: signal(),
    observation: observeCall((fact) => {
      if (fact.kind === 'started') assert.fail('must not observe start');
    }),
  });
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
    const observation = observeCall((fact) => {
      if (fact.kind === 'finished') finished.push(fact.state);
    });
    const invocation = new Invocation({ context: new InvocationContext('input'), work: { execute, maxRounds: 1 }, signal: signal(), observation });
    await assert.rejects(invocation.run(), (error) => error === failure);
    assert.equal(invocation.context.state.error, failure);
    assert.deepEqual(finished, [invocation.context.state]);
  }
});

test('successful invocation keeps its outcome when terminal registration throws', async () => {
  const failure = new Error('cannot finish record');
  let finishes = 0;
  const observation = observeCall((fact) => {
    if (fact.kind === 'finished') {
      finishes++;
      throw failure;
    }
  });
  const invocation = new Invocation({ context: new InvocationContext('input'), work: { execute: () => 'output', maxRounds: 1 }, signal: signal(), observation });
  await assert.rejects(invocation.run(), (error) => error.code === 'OBSERVATION_FAILED' && error.cause === failure);
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
    observation: observeCall((fact) => {
      if (fact.kind === 'started') order.push('register');
    }),
    work: {
      maxRounds: 1,
      execute() {
        order.push('execute');
        return 'done';
      },
    },
  });
  assert.equal(await invocation.run(), 'done');
  assert.deepEqual(order, ['validate', 'started', 'register', 'validate', 'execute', 'validate']);
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
    observation: observeCall((fact) => {
      if (fact.kind === 'started') assert.fail('must not observe start');
    }),
    work: { maxRounds: 1, execute: () => assert.fail('must not execute') },
  });
  await assert.rejects(invocation.run(), (error) => error === failure);
  assert.equal(invocation.context.state.error, failure);
});

test('started rejects returned values before publishing started or entering work', async () => {
  for (const returned of [false, 0, 'registered', {}]) {
    const facts = [];
    const invocation = new Invocation({
      context: new InvocationContext('input'),
      signal: signal(),
      started: () => returned,
      progress: {
        receive(fact) {
          facts.push(fact);
        },
      },
      work: { maxRounds: 1, execute: () => assert.fail('invalid setup must prevent work') },
    });
    await assert.rejects(invocation.run(), /started callbacks must return undefined synchronously/);
    assert.equal(invocation.context.status, 'failed');
    assert.equal(invocation.context.progress.round, 0);
    assert.equal(invocation.failure.phase, 'setup');
    assert.deepEqual(
      facts.map(({ kind }) => kind),
      ['finished'],
    );
  }
});

test('async started is rejected immediately and its late failure is consumed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false;
  const invocation = new Invocation({
    context: new InvocationContext('input'),
    signal: signal(),
    async started() {
      await pending;
      completed = true;
      throw new Error('late setup failure');
    },
    work: { maxRounds: 1, execute: () => assert.fail('async setup must prevent work') },
  });
  try {
    await assert.rejects(invocation.run(), /started callbacks must return undefined synchronously/);
    assert.equal(completed, false);
    assert.equal(invocation.context.status, 'failed');
    assert.equal(invocation.context.progress.round, 0);
  } finally {
    release();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, true);
  assert.match(invocation.context.state.error.message, /synchronously/);
});

test('started registers a single invocation once across its local continuation', async () => {
  let registrations = 0;
  const inputs = [];
  const invocation = new Invocation({
    context: new InvocationContext(0),
    signal: signal(),
    started() {
      registrations++;
    },
    work: {
      maxRounds: 2,
      execute(context) {
        inputs.push(context.currentInput);
        return context.currentInput + 1;
      },
      accept(context, output) {
        return context.progress.round === 1 ? context.continueWith(output, 'advance once') : output;
      },
    },
  });
  assert.equal(await invocation.run(), 2);
  assert.equal(registrations, 1);
  assert.deepEqual(inputs, [0, 1]);
});

test('constructing a low-level call does not read stage contracts before started can install acceptance', async () => {
  const reads = [];
  const processes = [];
  const initial = { answer: 'work result' };
  const accepted = { answer: 'accepted result' };
  let started = false;
  let receive;
  const read = (name) => {
    assert.equal(started, true, `${name} must not be read during construction`);
    reads.push(name);
  };
  const work = {
    get maxRounds() {
      read('maxRounds');
      return 1;
    },
    get output() {
      read('output');
      return { result: (value) => value };
    },
    get accept() {
      read('accept');
      return receive;
    },
    get exceptions() {
      read('exceptions');
      return undefined;
    },
    execute() {
      assert.equal(this, work);
      return initial;
    },
  };
  const context = new InvocationContext('input');
  const invocation = new Invocation({
    context,
    signal: signal(),
    work,
    started(current, call) {
      assert.deepEqual(reads, []);
      assert.equal(current, context);
      assert.equal(call, invocation);
      started = true;
      receive = function (currentContext, output, currentCall) {
        assert.equal(this, work);
        assert.equal(currentContext, context);
        assert.equal(currentCall, invocation);
        assert.equal(output, initial);
        return accepted;
      };
    },
    observation: observeCall((fact) => {
      if (fact.kind === 'process') processes.push(fact.process);
    }),
  });
  assert.deepEqual(reads, []);
  assert.equal(await invocation.run(), accepted);
  assert.equal(context.state.output, accepted);
  for (const key of ['maxRounds', 'output', 'accept']) assert.ok(reads.includes(key));
  const returned = processes.find((process) => process.stage === 'receive' && process.type === 'return');
  assert.equal(returned.output, accepted);
  assert.equal('reuse' in returned, false);
});
