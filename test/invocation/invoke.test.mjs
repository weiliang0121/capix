import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoke } from '@capix-observer/runtime';

test('one lifecycle can overlap invocations without mixing handles or outputs', async () => {
  let next = 0;
  const pending = new Map();
  const ended = [];
  const lifecycle = {
    begin: () => ({ id: ++next }),
    succeed: (handle, output) => ended.push([handle.id, output]),
    fail: () => assert.fail('unexpected failure'),
  };
  const work = (handle) => new Promise((resolve) => pending.set(handle.id, resolve));
  const first = invoke(lifecycle, work);
  const second = invoke(lifecycle, work);
  assert.deepEqual(ended, []);
  const a = { answer: 'a' },
    b = { answer: 'b' };
  pending.get(2)(b);
  assert.equal(await second, b);
  pending.get(1)(a);
  assert.equal(await first, a);
  assert.deepEqual(ended, [
    [2, b],
    [1, a],
  ]);
});

test('begin and success-registration failures never enter work-failure handling', async () => {
  const failure = new Error('registration');
  let worked = false;
  const fail = () => assert.fail('must not reinterpret registration failure as work failure');
  await assert.rejects(
    invoke(
      {
        begin: () => {
          throw failure;
        },
        succeed() {},
        fail,
      },
      () => {
        worked = true;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(worked, false);
  await assert.rejects(
    invoke(
      {
        begin: () => ({}),
        succeed: () => {
          throw failure;
        },
        fail,
      },
      () => {
        worked = true;
        return 'result';
      },
    ),
    (error) => error === failure,
  );
  assert.equal(worked, true);
});

test('sync and async work failures keep their identity and register once', async () => {
  const failure = new Error('work');
  for (const work of [
    () => {
      throw failure;
    },
    async () => {
      throw failure;
    },
  ]) {
    const handle = {};
    const errors = [];
    await assert.rejects(
      invoke(
        {
          begin: () => handle,
          succeed: () => assert.fail('unexpected success'),
          fail: (actual, error) => {
            assert.equal(actual, handle);
            errors.push(error);
          },
        },
        work,
      ),
      (error) => error === failure,
    );
    assert.deepEqual(errors, [failure]);
  }
});

test('failed failure-registration preserves both errors', async () => {
  const workError = new Error('work');
  const registrationError = new Error('registration');
  await assert.rejects(
    invoke(
      {
        begin: () => ({}),
        succeed() {},
        fail: () => {
          throw registrationError;
        },
      },
      () => {
        throw workError;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, workError);
      assert.deepEqual(error.errors, [workError, registrationError]);
      return true;
    },
  );
});
