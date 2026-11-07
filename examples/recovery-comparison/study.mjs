import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cuts, launch } from './harness.mjs';

// Durable artifacts for comparison, not a CPU/throughput benchmark. Diagnostics
// make additional SQL writes and the scenario has only three operations.
const destination = resolve(process.argv[2] ?? '.capix/recovery-comparison');
mkdirSync(destination);
const results = [];
for (const mode of ['explicit', 'replay']) {
  const normal = launch('run', join(destination, `${mode}-normal`), mode);
  assert.equal(normal.status, 'completed');
  results.push({ mode, cut: 'none', result: normal });
  for (const expected of cuts) {
    const directory = join(destination, `${mode}-${expected.cut}`);
    launch('run', directory, mode, { cut: expected.cut });
    const before = launch('inspect', directory, mode);
    const result = launch('resume', directory, mode);
    assert.equal(result.status, expected.status);
    assert.equal(result.world.counts.model ?? 0, expected.model);
    assert.equal(result.world.counts.entity ?? 0, expected.entity);
    const recoveryMetrics = Object.fromEntries(Object.entries(result.metrics).map(([key, value]) => [key, value - (before.metrics[key] ?? 0)]));
    results.push({ mode, cut: expected.cut, before, recoveryMetrics, result });
  }
}
const directory = fileURLToPath(new URL('.', import.meta.url));
const files = ['model.mjs', 'scenario.mjs', 'process.mjs', 'harness.mjs', 'study.mjs', 'recovery.test.mjs', 'contract-boundaries.test.mjs', 'runtime-boundaries.test.mjs', 'cold-validation.test.mjs'];
const sources = Object.fromEntries(
  files.map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(join(directory, file)))
      .digest('hex'),
  ]),
);
const report = { format: 'capix-recovery-comparison@1', node: process.version, generatedAt: new Date().toISOString(), scope: 'serial candidate protocols; not production recovery qualification or performance benchmark', sources, results };
writeFileSync(join(destination, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ destination, rows: results.length, normal: results.filter((row) => row.cut === 'none').map((row) => ({ mode: row.mode, metrics: row.result.metrics, effects: row.result.world.counts })) }, null, 2));
