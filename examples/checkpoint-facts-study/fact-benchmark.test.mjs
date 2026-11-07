import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFactBenchmark } from './fact-benchmark.mjs';

test('fact benchmark counts independent metadata and new facts without reading old bodies during save', () => {
  const result = runFactBenchmark({ children: 8, inputBytes: 128, outputBytes: 64, mode: 'incremental' }, ':memory:');
  assert.equal(result.totals.store.metadataEvents, 8 * 8 + 1);
  assert.equal(result.totals.call.encodedFacts, 8 * 3 + 1);
  assert.equal(result.totals.store.oldBodyReads, 0);
  assert.equal(result.rows.length, 16);
  assert.equal(result.totals.call.factReads, 8, 'normal business receive returns each new accepted value once, outside save');
  assert.equal(
    result.rows.reduce((total, row) => total + row.saveCall.factReads, 0),
    0,
  );
  assert.equal(result.noChange.store.metadataEvents, 0);
  assert.equal(result.noChange.call.stateEncodes, 1);
});

test('negative controls expose author whole-history checking and repeated refs despite no old database body reads', () => {
  const size = 8;
  const options = { children: size, inputBytes: 128, outputBytes: 64 };
  const checks = runFactBenchmark({ ...options, mode: 'full-check' }, ':memory:');
  const refs = runFactBenchmark({ ...options, mode: 'rewrite-refs' }, ':memory:');
  assert.equal(checks.totals.call.authoredScans, size * (size + 1));
  assert.equal(
    checks.rows.reduce((total, row) => total + row.saveCall.factReads, 0),
    2 * size * size,
  );
  assert.equal(refs.totals.store.metadataEvents, size * 8 + 1 + size * (size + 1));
  assert.equal(refs.totals.call.referenceUpdates, size + size * (size + 1));
  assert.equal(checks.totals.store.oldBodyReads, 0);
  assert.equal(refs.totals.store.oldBodyReads, 0);
  assert.ok(refs.summary.last.maxEvents > refs.summary.first.maxEvents);
});
