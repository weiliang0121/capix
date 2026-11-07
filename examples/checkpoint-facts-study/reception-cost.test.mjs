import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureReceptionCost } from './reception-cost.mjs';
import { measureActionCost } from './action-cost.mjs';

for (const children of [1, 8, 32])
  test(`reception first-persistence checks are linear; later saves do not access old bodies (N=${children})`, () => {
    const result = measureReceptionCost({ children });
    assert.equal(result.saves, children * 2);
    assert.equal(result.counts.establishmentCheck, children);
    assert.equal(result.counts.persistenceCheck, children);
    assert.equal(result.counts.receptionEncode, children);
    assert.equal(result.saveChecks, children);
    assert.equal(result.oldSaveChecks, 0);
    assert.equal(result.oldSaveEncodes, 0);
    assert.equal(result.store.oldBodyReads, 0);
    for (const key of ['establishmentCheck', 'persistenceCheck', 'receptionEncode', 'persistenceDecode', 'encodingBodyReads']) assert.equal(result.unchangedSave.evidence[key], 0);
    assert.equal(result.unchangedSave.store.oldBodyReads, 0);
    assert.equal(result.unchangedSave.store.factsWritten, 0);
  });

test('comparison keeps normal establishment checks separate from the real v5 save-only counter', async () => {
  const children = 8;
  const before = await measureActionCost({ children });
  const after = measureReceptionCost({ children });
  assert.equal(before.counts.receptionCheck, children ** 2);
  assert.equal(before.counts.oldReceptionCheck, children * (children - 1));
  assert.equal(after.saveChecks, children);
  assert.equal(after.counts.establishmentCheck, children);
});
