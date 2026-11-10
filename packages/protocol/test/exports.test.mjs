import test from 'node:test';

import assert from 'node:assert/strict';

test('shared protocol has no UI projection or server entity exports', async () => {
  const protocol = await import('@weiliang0121/capix-protocol');
  assert.equal(typeof protocol.readOutput, 'function');
  assert.equal(typeof protocol.validateExecutionRecordSnapshot, 'function');
  for (const name of ['Runtime', 'Transcript', 'Memory', 'projectExecution', 'createObserverServer']) assert.ok(!(name in protocol), `${name} does not belong to the wire contract`);
});

test('wire callable vocabulary is the common contracts identity', async () => {
  const protocol = await import('@weiliang0121/capix-protocol');
  const contracts = await import('@weiliang0121/capix-contracts');
  assert.equal(protocol.callableKinds, contracts.callableKinds);
});
