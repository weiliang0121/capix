import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const make = (execute, options = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { execute }, ...options });

test('repeated child start and a preconstructed child after parent failure cannot run business', async () => {
  let count = 0;
  let second;
  const parent = make(async (_context, owner) => {
    const first = make(() => ++count, { parent: { invocation: owner } });
    second = make(() => ++count, { parent: { invocation: owner } });
    await first.run();
    await assert.rejects(first.run(), /once|started/);
    await assert.rejects(second.run());
  });
  await assert.rejects(parent.run(), /once|started/);
  assert.equal(count, 1);
  assert.equal(second.context.status, 'failed');
});
