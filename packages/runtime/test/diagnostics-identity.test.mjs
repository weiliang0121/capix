import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';

import * as invocation from '@weiliang0121/capix-invocation';

import * as runtime from '@weiliang0121/capix-runtime';

test('diagnostics owns the same error and formatter objects exposed by compatibility entrypoints', () => {
  for (const entry of [invocation, runtime]) {
    assert.equal(entry.PersistenceError, PersistenceError);
    assert.equal(entry.RuntimeErrorHelper, RuntimeErrorHelper);
    assert.equal(entry.RuntimeErrorHelper.format, RuntimeErrorHelper.format);
  }
  const cause = new Error('database unavailable');
  const failure = new PersistenceError('interaction.commit', cause);
  assert.ok(failure instanceof RuntimeError);
  assert.ok(failure instanceof invocation.PersistenceError);
  assert.ok(failure instanceof runtime.PersistenceError);
  assert.equal(failure.code, 'PERSISTENCE_FAILED');
  assert.equal(failure.operation, 'interaction.commit');
  assert.equal(failure.cause, cause);
  assert.equal(failure.name, 'PersistenceError');
});
