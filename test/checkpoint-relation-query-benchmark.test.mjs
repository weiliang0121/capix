import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { relationQuerySample } from '../examples/checkpoint-computation/relation-query.mjs';

test('relation query diagnostic separates actual SQL reads, repeated parsing and changed facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-relation-query-'));
  const originalParse = JSON.parse;
  const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const plan = { family: 'growth', n: 8, inputBytes: 1024, valueBytes: 64 };
    const all = await relationQuerySample({ ...plan, refs: 'all' }, join(directory, 'all.sqlite'));
    const current = await relationQuerySample({ ...plan, refs: 'current' }, join(directory, 'current.sqlite'));
    for (const result of [all, current]) {
      assert.equal(result.status, 'completed');
      assert.equal(result.saved.group.saves, 17);
      assert.equal(result.changedParentRelations, 16);
      assert.ok(result.counts.relationSqlReads >= result.counts.relationSqlRows);
      assert.ok(result.counts.relationSqlBytes > 0);
      assert.equal(result.report.samples[0].checkpointMs, null, 'instrumented samples are not timing evidence');
    }
    assert.ok(all.counts.relationSqlRows > current.counts.relationSqlRows, 'all still reads the selected history');
    assert.ok(all.counts.relationSqlRows > all.counts.relationEnvelopeParses, 'an unchanged row reuses parsing, not its SQL read');
    assert.equal(all.counts.relationEnvelopeParses, 16, 'each observed waiting/accepted row is parsed once');
    assert.equal(current.counts.relationSqlRows, current.counts.relationEnvelopeParses, 'current has no repeated selected-history parsing to remove');
    assert.equal(JSON.parse, originalParse);
    assert.equal(DatabaseSync.prototype.prepare, originalPrepare);
    await assert.rejects(relationQuerySample({ ...plan, n: -1, refs: 'all' }, join(directory, 'invalid.sqlite')));
    assert.equal(JSON.parse, originalParse, 'failure releases the diagnostic hook');
    assert.equal(DatabaseSync.prototype.prepare, originalPrepare);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('incremental selections keep the same saves while avoiding selected-history SQL reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-selection-query-'));
  try {
    const plan = { family: 'growth', n: 16, inputBytes: 1024, valueBytes: 64 };
    const all = await relationQuerySample({ ...plan, refs: 'all' }, join(directory, 'all.sqlite'));
    const incremental = await relationQuerySample({ ...plan, refs: 'incremental' }, join(directory, 'incremental.sqlite'));
    assert.equal(all.status, 'completed');
    assert.equal(incremental.status, 'completed');
    assert.deepEqual(incremental.saved, all.saved);
    assert.equal(incremental.changedParentRelations, all.changedParentRelations);
    assert.ok(incremental.counts.relationSqlReads < all.counts.relationSqlReads / 2);
    const parent = incremental.report.samples.filter((sample) => sample.owner === 'group');
    assert.equal(
      parent.reduce((sum, sample) => sum + sample.selectionAppends, 0),
      plan.n,
    );
    assert.equal(
      parent.reduce((sum, sample) => sum + sample.selectionRemovals, 0),
      0,
    );
    assert.ok(parent.filter((sample) => sample.phase !== 'dispatch').every((sample) => sample.selectionChanges === 0));
    assert.ok(incremental.counts.selectionSqlReads <= 2 * plan.n + 1);
    assert.equal(incremental.counts.occurrenceSqlReads, plan.n, 'only appended identities need point reads');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
