import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { RuntimeError } from '@capix/contracts';
import { PersistenceError, RuntimeErrorHelper } from '@capix/diagnostics';
import * as invocation from '@capix/invocation';
import * as runtime from '@capix/server-runtime';

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

test('Invocation protects diagnostics persistence failures by identity, including aggregate members', () => {
  const failure = new PersistenceError('interaction.read', new Error('read failed'));
  const policy = invocation.invocationResourceFailures;
  assert.equal(policy.describe, RuntimeErrorHelper.format);
  assert.equal(policy.isProtected(failure), true);
  assert.equal(policy.isProtected(new AggregateError([new Error('ordinary'), new AggregateError([failure], 'nested')], 'both')), true);
  assert.equal(policy.isProtected(new RuntimeError('PERSISTENCE_FAILED', 'same code is not an authentic persistence failure')), false);
  assert.equal(policy.isProtected(new Error('ordinary operation failure')), false);
});

test('diagnostics has no dependency on live invocation, structure, resources or Runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../server/diagnostics/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@capix/diagnostics');
  assert.deepEqual(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).sort(), ['@capix/contracts', 'es-toolkit']);
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
});
