import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSavedFacts } from './saved-facts-cost.mjs';

for (const children of [8, 128]) {
  test(`saved facts no-demand keeps declaration authentication at N=${children}`, () => {
    const result = measureSavedFacts({ children, mode: 'none' });
    assert.equal(result.view.wrappersBuilt, 0);
    assert.equal(result.view.bodyReads, 0);
    assert.equal(result.view.enumerationItems, 0);
    assert.equal(result.view.referenceValidationItems, children * 3);
    assert.equal(result.view.singleItems, children * 2);
    assert.equal(result.view.baselineItems, 1);
    assert.equal(result.view.deltaItems, children - 1);
    assert.equal(result.view.baselineValidations, 1);
    assert.equal(result.view.relationBaselineItems, 1);
    assert.equal(result.view.relationDeltaItems, children - 1);
    assert.equal(result.reception.persistenceCheck, children);
    assert.equal(result.reception.establishmentCheck, children);
    assert.equal(result.samples.length, result.saves);
  });

  test(`saved facts current selection avoids old relation adaptation at N=${children}`, () => {
    const result = measureSavedFacts({ children });
    assert.equal(result.view.wrappersBuilt, children * 2);
    assert.equal(result.view.bodyReads, children * 4);
    assert.equal(result.view.enumerationItems, 0);
    assert.equal(result.facts.authoredScans, 0);
    assert.equal(result.store.oldBodyReads, 0);
    for (const sample of result.samples) {
      assert.equal(sample.view.wrappersBuilt, 1);
      assert.equal(sample.view.bodyReads, sample.phase === 'waiting' ? 1 : 3);
      assert.equal(sample.reception.persistenceCheck, sample.phase === 'waiting' ? 0 : 1);
    }
    assert.equal(result.noNewFacts.view.wrappersBuilt, 1);
    assert.equal(result.noNewFacts.view.bodyReads, 3);
    assert.equal(result.noNewFacts.reception.persistenceCheck, 0);
    assert.equal(result.noNewFacts.facts.encodedFacts, 0);
    assert.equal(result.noNewFacts.store.factsWritten, 0);
    assert.equal(result.noNewFacts.view.referenceValidationItems, 1);
    assert.equal(result.noNewFacts.view.deltaEvents, 0);
    assert.equal(result.noNewFacts.view.relationBaselineItems, 0);
    assert.equal(result.noNewFacts.view.relationDeltaItems, 0);
  });

  test(`saved facts explicit full demand and eager control expose quadratic adaptation at N=${children}`, () => {
    const all = measureSavedFacts({ children, mode: 'all' });
    const eager = measureSavedFacts({ children, eager: true });
    for (const result of [all, eager]) {
      assert.equal(result.view.wrappersBuilt, children * (children + 1));
      assert.equal(result.view.enumerationItems, children * (children + 1));
      assert.equal(result.view.bodyReads, 3 * children ** 2 + children);
      assert.equal(result.view.referenceValidationItems, children * 3);
      assert.equal(result.reception.persistenceCheck, children);
    }
    assert.equal(all.authorRows, children * (children + 1));
    assert.equal(eager.authorRows, 0);
  });
}
