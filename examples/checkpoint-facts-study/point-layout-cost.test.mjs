import assert from 'node:assert/strict';
import test from 'node:test';
import { measurePointLayouts } from './point-layout-cost.mjs';

for (const children of [8, 128]) {
  test(`point layout switches retain exact authentication without repeated history at N=${children}`, () => {
    const result = measurePointLayouts({ children, switches: 30 });
    assert.equal(result.growth.view.wrappersBuilt, children);
    assert.equal(result.growth.view.bodyReads, children * 3);
    assert.equal(result.growth.view.relationBaselineItems, 1);
    assert.equal(result.growth.view.relationDeltaItems, children - 1);
    assert.equal(result.growth.view.baselineItems, 1);
    assert.equal(result.growth.view.deltaItems, children - 1);
    assert.equal(result.growth.receptions.persistenceCheck, children);
    assert.equal(result.growth.authorChecks, children * 2);
    assert.equal(result.switched.authorChecks, 30);
    assert.equal(result.switched.view.wrappersBuilt, 20);
    assert.equal(result.switched.view.bodyReads, 60);
    assert.equal(result.switched.view.relationBaselineItems, 0);
    assert.equal(result.switched.view.relationDeltaItems, 0);
    assert.equal(result.switched.view.baselineItems, 0);
    assert.equal(result.switched.view.deltaItems, 0);
    assert.equal(result.switched.view.enumerationItems, 0);
    assert.equal(result.switched.facts.encodedFacts, 0);
    assert.equal(result.switched.receptions.persistenceCheck, 0);
    assert.equal(result.switched.store.factsWritten, 0);
    assert.equal(result.switched.store.oldBodyReads, 0);
    assert.equal(result.switched.store.commits, 30);
  });
}
