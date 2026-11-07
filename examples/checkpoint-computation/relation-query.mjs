import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSample } from './fixture.mjs';

/** Isolated diagnostic process only. These hooks must never be used for timing. */
export async function relationQuerySample(plan, path) {
  const counts = { relationSqlReads: 0, relationSqlRows: 0, relationSqlBytes: 0, relationEnvelopeParses: 0 };
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalParse = JSON.parse;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (/SELECT child_id,\s*ordinal,\s*body FROM checkpoint_relations WHERE context_id\s*=\s*\? AND child_id\s*=\s*\?/i.test(sql)) {
      const originalGet = statement.get;
      statement.get = function (...args) {
        counts.relationSqlReads++;
        const row = originalGet.apply(this, args);
        if (row !== undefined) {
          counts.relationSqlRows++;
          if (typeof row.body === 'string') counts.relationSqlBytes += Buffer.byteLength(row.body);
        }
        return row;
      };
    }
    return statement;
  };
  JSON.parse = function (text, reviver) {
    if (typeof text === 'string' && text.startsWith('{"format":"capix.checkpoint.record@1","kind":"child",')) counts.relationEnvelopeParses++;
    return originalParse(text, reviver);
  };
  let report;
  try {
    report = await runSample({ ...plan, mode: 'diagnostic', store: 'sqlite' }, { path });
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    JSON.parse = originalParse;
  }
  return {
    plan,
    status: report.status,
    counts,
    changedRelations: report.samples.reduce((sum, sample) => sum + (sample.relationEntries ?? 0), 0),
    changedParentRelations: report.samples.filter((sample) => sample.owner === 'group').reduce((sum, sample) => sum + (sample.relationEntries ?? 0), 0),
    saved: report.stores.byOwner,
    report,
    note: 'Point SELECT attempts, nonempty rows and returned encoded-body bytes are actual JS/SQLite observations, not physical disk I/O. Envelope parses count decode attempts, not all authentication logic. SQL rows minus parses only describes exact-row decode reuse in this successful sample; reference checks still run. Diagnostic elapsed times are invalid for performance comparison.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, output, n = '128', refs = 'all'] = process.argv.slice(2);
  if (!path || !output || !['current', 'all'].includes(refs)) throw new Error('Pass NEW_DB OUTPUT_JSON [N] [current|all]');
  const result = await relationQuerySample({ family: 'growth', n: Number(n), refs, inputBytes: 1024, valueBytes: 64 }, path);
  await writeFile(output, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, counts: result.counts, changedParentRelations: result.changedParentRelations }));
}
