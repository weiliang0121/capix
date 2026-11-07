import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureActionCost } from './action-cost.mjs';

test('actual CP repeats internal facts without any resource or mutable handoff', async () => {
  for (const children of [2, 8]) {
    const result = await measureActionCost({ children });
    assert.equal(result.resourceOperations, 0);
    assert.equal(result.parentSaves, 2 * children);
    assert.equal(result.parentCapturedChildren, children * (children + 1));
    assert.equal(result.counts.parentInputEncode, 4 * children);
    assert.equal(result.counts.childInputEncode, 2 * children * children + children);
    assert.equal(result.counts.childOutputEncode, children * children);
    assert.equal(result.counts.receptionEncode, children * children);
    assert.equal(result.counts.receptionCheck, children * children);
    assert.equal(result.counts.oldOutputEncode, children * (children - 1));
    assert.equal(result.counts.oldReceptionCheck, children * (children - 1));
    assert.equal(result.lastAccepted.counts.receptionCheck, children);
    assert.equal(result.fixing.bodyVisitsInSaves, 0, 'The experimental fixed-value owner does not rerun, but CP still recaptures its values');
  }
});

test('private draft assignments add local work, not implicit snapshots or CP work', async () => {
  const baseline = await measureActionCost({ children: 8 });
  const edited = await measureActionCost({ children: 8, draftEdits: 1000 });
  assert.equal(edited.privateEdits, 8000);
  assert.deepEqual(edited.counts, baseline.counts);
  assert.deepEqual(edited.fixing, baseline.fixing);
  assert.equal(edited.parentCapturedChildren, baseline.parentCapturedChildren);
  assert.deepEqual(
    edited.samples.map((sample) => sample.bytes),
    baseline.samples.map((sample) => sample.bytes),
  );
});

test('ordinary resource access is separate from CP historical validation', async () => {
  const local = await measureActionCost({ children: 8 });
  const external = await measureActionCost({ children: 8, resource: true });
  assert.equal(local.resourceOperations, 0);
  assert.equal(external.resourceOperations, 8);
  assert.deepEqual(external.counts, local.counts);
  assert.equal(external.parentCapturedChildren, local.parentCapturedChildren);
  assert.deepEqual(external.fixing, local.fixing);
});

test('CP disabled leaves publication and resource work, without serialization callbacks', async () => {
  const result = await measureActionCost({ children: 8, resource: true, draftEdits: 1000, checkpoints: false });
  assert.equal(result.resourceOperations, 8);
  assert.equal(result.privateEdits, 8000);
  assert.equal(result.parentSaves, 0);
  assert.ok(Object.values(result.counts).every((value) => value === 0));
  assert.ok(result.fixing.visits > 0, 'Stable handoffs in this fixture do not depend on CP');
});
