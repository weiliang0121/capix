import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAuthorBenchmark } from './author-benchmark.mjs';

test('many refs + bounded point queries do not enumerate or reencode previous relations', () => {
  const small = runAuthorBenchmark({ children: 8 });
  const large = runAuthorBenchmark({ children: 32 });
  for (const result of [small, large]) {
    assert.equal(result.totals.call.referenceScans, 0);
    assert.equal(result.totals.call.authoredScans, 0);
    assert.equal(result.totals.store.oldBodyReads, 0);
    assert.equal(result.totals.call.encodedFacts, 1 + 3 * result.config.children);
    assert.equal(result.noop.call.encodedFacts, 0);
    assert.equal(result.noop.store.metadataEvents, 0);
    assert.equal(result.noop.call.factReads, 2, 'An author check may deliberately query two old facts');
  }
  const steady = (result) => result.rows.filter((row) => row.phase === 'accepted').at(-1);
  assert.equal(steady(small).store.metadataReads, steady(large).store.metadataReads);
  assert.equal(steady(small).store.metadataEvents, steady(large).store.metadataEvents);
});

test('explicit full enumeration and inline growing state remain visible independent costs', () => {
  const enumerated = runAuthorBenchmark({ children: 16, mode: 'enumerate' });
  assert.equal(enumerated.totals.call.referenceScans, 16 * 17 + 16, 'Two enumerations each step, plus final no-change check');
  const bounded = runAuthorBenchmark({ children: 32 });
  const inline = runAuthorBenchmark({ children: 32, mode: 'inline-history' });
  assert.ok(inline.summary.stateBytes > bounded.summary.stateBytes * 3);
  assert.ok(inline.totals.store.headBytesWritten > bounded.totals.store.headBytesWritten);
  assert.equal(inline.totals.call.encodedFacts, bounded.totals.call.encodedFacts, 'State history cost is not fact reencoding');
});
