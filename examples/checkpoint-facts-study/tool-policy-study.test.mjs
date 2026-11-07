import assert from 'node:assert/strict';
import { test } from 'node:test';
import { studyToolPolicy } from './tool-policy-study.mjs';

test('policy study separates full oracle scans, fixture translation, and candidate assertion scope', () => {
  const result = studyToolPolicy();
  assert.equal(result.rows.length, 13);
  assert.equal(result.candidate.fullChecks, 1);
  assert.equal(result.candidate.historicalModelAssertions, 0);
  assert.ok(result.original.allRelationItems > 0);
  assert.ok(result.candidate.fixtureComparisons > 0);
  assert.ok(result.candidate.modelPrefixItems > 0, 'New models still use array prefixes in the equivalence probe');
  assert.equal(result.repeated.modelAssertions, 0);
  assert.equal(result.repeated.currentQueries, 1);
});
