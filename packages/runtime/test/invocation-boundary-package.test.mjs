import assert from 'node:assert/strict';

import { test } from 'node:test';

test('Runtime compatibility exports preserve invocation and error identities', async () => {
  const invocation = await import('@weiliang0121/capix-invocation');
  const runtime = await import('@weiliang0121/capix-runtime');
  const construction = await import('@weiliang0121/capix-runtime/construction');
  const contracts = await import('@weiliang0121/capix-contracts');
  for (const name of ['Invocation', 'InvocationContext', 'CallableContext', 'InvocationResources', 'invocationResourceFailures', 'inspectChildCallFailure']) {
    assert.ok(name in invocation);
    assert.equal(runtime[name], invocation[name], name);
    assert.equal(construction[name], invocation[name], name);
  }
  for (const name of ['RuntimeError', 'ExceptionContract', 'DeclaredException', 'ChildCallFailure', 'InvocationCancelled', 'ObservationError', 'PersistenceError']) {
    assert.ok(name in invocation);
    assert.equal(runtime[name], invocation[name], name);
  }
  assert.equal(invocation.RuntimeError, contracts.RuntimeError);
  const exception = new invocation.ExceptionContract('BOUNDARY_FAILURE').create('expected failure', { value: 1 });
  assert.ok(exception instanceof runtime.DeclaredException);
  assert.ok(exception instanceof contracts.RuntimeError);
  assert.ok(new runtime.ChildCallFailure(exception) instanceof invocation.ChildCallFailure);
});
