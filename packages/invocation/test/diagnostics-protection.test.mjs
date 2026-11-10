import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';

import * as invocation from '@weiliang0121/capix-invocation';

test('Invocation protects diagnostics persistence failures by identity, including aggregate members', () => {
  const failure = new PersistenceError('interaction.read', new Error('read failed'));
  const policy = invocation.invocationResourceFailures;
  assert.equal(policy.describe, RuntimeErrorHelper.format);
  assert.equal(policy.isProtected(failure), true);
  assert.equal(policy.isProtected(new AggregateError([new Error('ordinary'), new AggregateError([failure], 'nested')], 'both')), true);
  assert.equal(policy.isProtected(new RuntimeError('PERSISTENCE_FAILED', 'same code is not an authentic persistence failure')), false);
  assert.equal(policy.isProtected(new Error('ordinary operation failure')), false);
});
