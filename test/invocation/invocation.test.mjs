import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext } from '@capix-observer/runtime';

const signal = () => new AbortController().signal;

test('separate Invocations can overlap without mixing contexts or outputs', async () => {
  const pending = new Map();
  const create = (input) => new Invocation(() => new InvocationContext(input), { maxRounds: 1, execute: (context) => new Promise((resolve) => pending.set(context.input, resolve)) }, signal());
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

test('failed preparation creates no context or record and cannot reuse the Invocation', async () => {
  const failure = new Error('prepare failed');
  const invocation = new Invocation(
    () => {
      throw failure;
    },
    { maxRounds: 1, execute: () => assert.fail('must not run') },
    signal(),
    undefined,
    () => assert.fail('must not register'),
  );
  await assert.rejects(invocation.run(), (error) => error === failure);
  assert.equal(invocation.context, undefined);
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
      begin() {},
      process() {},
      finish(context) {
        finished.push(context);
      },
    };
    const invocation = new Invocation(() => new InvocationContext('input'), { execute, maxRounds: 1 }, signal(), recorder);
    await assert.rejects(invocation.run(), (error) => error === failure);
    assert.equal(invocation.context.state.error, failure);
    assert.deepEqual(finished, [invocation.context]);
  }
});

test('successful invocation keeps its outcome when terminal registration throws', async () => {
  const failure = new Error('cannot finish record');
  let finishes = 0;
  const recorder = {
    begin() {},
    process() {},
    finish() {
      finishes++;
      throw failure;
    },
  };
  const invocation = new Invocation(() => new InvocationContext('input'), { execute: () => 'output', maxRounds: 1 }, signal(), recorder);
  await assert.rejects(invocation.run(), (error) => error.code === 'RECORDING_FAILED' && error.cause === failure);
  assert.deepEqual(invocation.context.state, { status: 'succeeded', output: 'output' });
  assert.equal(finishes, 1);
});
