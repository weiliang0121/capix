import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { PersistenceError, RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';

test('PersistenceError owns operation, cause and the common RuntimeError identity', () => {
  const cause = new Error('database unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(PersistenceError, 'name');
  Object.defineProperty(PersistenceError, 'name', { value: 'n' });
  try {
    const failure = new PersistenceError('interaction.commit', cause);
    assert.ok(failure instanceof RuntimeError);
    assert.equal(failure.code, 'PERSISTENCE_FAILED');
    assert.equal(failure.operation, 'interaction.commit');
    assert.equal(failure.cause, cause);
    assert.equal(failure.name, 'PersistenceError');
    assert.equal(RuntimeErrorHelper.format(failure).name, 'PersistenceError');
  } finally {
    Object.defineProperty(PersistenceError, 'name', descriptor);
  }
});

test('diagnostics classify real errors independently of the prototype and skip nested opaque objects', () => {
  const error = Object.setPrototypeOf(new Error('real'), null);
  assert.equal(RuntimeErrorHelper.format(error).message, 'real');
  const lookalike = Object.assign(Object.create(Error.prototype), { message: 'data' });
  const diagnostic = RuntimeErrorHelper.format(lookalike);
  assert.equal(diagnostic.code, 'NON_ERROR_THROWN');
  assert.equal(diagnostic.detail.message, 'data');

  let inspected = false;
  const detail = new Proxy(
    {},
    {
      getPrototypeOf() {
        inspected = true;
        return Object.prototype;
      },
    },
  );
  const failure = Object.assign(new Error('outer'), { detail });
  assert.equal(RuntimeErrorHelper.format(failure).detail, '[Uninspectable value]');
  assert.equal(inspected, false);
});
