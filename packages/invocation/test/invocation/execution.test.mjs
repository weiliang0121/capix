import assert from 'node:assert/strict';

import { test } from 'node:test';

import { InvocationCancelled, Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const make = (execute, options = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { execute }, ...options });

test('ordinary unhandled errors retain their identity without exception declarations', async () => {
  for (const error of [new Error('work'), new TypeError('domain'), undefined, null]) {
    const call = make(() => {
      throw error;
    });
    try {
      await call.run();
      assert.fail('must reject');
    } catch (actual) {
      assert.equal(actual, error);
    }
    assert.equal(call.context.state.error, error);
    assert.equal(call.context.status, 'failed');
  }
});

test('pre-cancellation does not enter the business function', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  const call = make(() => assert.fail('must not execute'), { signal: controller.signal });
  await assert.rejects(call.run(), (error) => error instanceof InvocationCancelled);
});

test('cancellation before the final result prevents successful delivery', async () => {
  const controller = new AbortController();
  const call = make(
    () => {
      controller.abort();
      return 'candidate';
    },
    { signal: controller.signal },
  );
  await assert.rejects(call.run(), (error) => error instanceof InvocationCancelled);
  assert.equal(call.context.status, 'failed');
});

test('success fixes the candidate once and output validation cannot replace the stable value', async () => {
  const value = { output: true };
  let validated;
  const good = make(() => value, {
    work: {
      execute: () => value,
      output: {
        result: (actual) => {
          assert.deepEqual(actual, value);
          assert.notEqual(actual, value);
          assert.equal(Object.isFrozen(actual), true);
          validated = actual;
          return actual;
        },
      },
    },
  });
  const result = await good.run();
  assert.equal(result, validated);
  assert.equal(good.context.state.output, result);
  const bad = make(() => value, { work: { execute: () => value, output: { result: () => ({ output: true }) } } });
  await assert.rejects(bad.run(), (error) => error.code === 'OUTPUT_CONTRACT');
});

test('work and output failures both remain visible when their reporting fails', async () => {
  const cause = new Error('business');
  const reporting = new Error('reporting');
  const call = make(
    () => {
      throw cause;
    },
    {
      changes: {
        publish(fact) {
          if (fact.kind === 'process' && fact.action === 'throw') throw reporting;
        },
      },
    },
  );
  await assert.rejects(call.run(), (error) => error instanceof AggregateError && error.errors.includes(cause));
});

test('cyclic aggregate errors do not recurse during classification', async () => {
  const failure = new AggregateError([], 'cyclic');
  failure.errors.push(failure);
  await assert.rejects(
    make(() => {
      throw failure;
    }).run(),
    (error) => error === failure,
  );
});
