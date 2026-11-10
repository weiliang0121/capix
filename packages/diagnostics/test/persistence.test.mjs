import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';

test('PersistenceError owns operation, cause and the common RuntimeError identity', () => {
  const cause = new Error('database unavailable');
  const failure = new PersistenceError('interaction.commit', cause);
  assert.ok(failure instanceof RuntimeError);
  assert.equal(failure.code, 'PERSISTENCE_FAILED');
  assert.equal(failure.operation, 'interaction.commit');
  assert.equal(failure.cause, cause);
  assert.equal(failure.name, 'PersistenceError');
  assert.equal(typeof RuntimeErrorHelper.format(failure).message, 'string');
});
