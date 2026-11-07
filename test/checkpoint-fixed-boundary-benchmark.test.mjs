import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBoundarySample } from '../examples/checkpoint-computation/fixed-boundary.mjs';

for (const input of ['raw', 'trusted'])
  test(`no-CP boundary fixture uses the real three-call Runner for ${input} ordinary data`, async () => {
    const result = await runBoundarySample({ profile: 'runner', input, shape: 'records', size: 8, iterations: 2 });
    assert.equal(result.status, 'completed');
    assert.equal(result.checkpoints, 0);
    assert.equal(result.callsPerRun, 3);
    assert.equal(result.samples.length, 2);
    assert.ok(result.samples.every((sample) => sample.elapsedMs >= 0 && sample.cpuMs >= 0));
  });

test('no-CP service fixture measures actual material assembly and formal messages with deterministic model feedback', async () => {
  const result = await runBoundarySample({ profile: 'service', historyBytes: 1024, iterations: 2 });
  assert.equal(result.status, 'completed');
  assert.equal(result.checkpoints, 0);
  assert.equal(result.samples.length, 2);
  assert.ok(result.samples.every((sample) => sample.modelCalls === 1 && sample.deltas === 2 && sample.requestTextUnits > 1024));
});
