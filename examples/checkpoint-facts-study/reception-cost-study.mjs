import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measureActionCost } from './action-cost.mjs';
import { measureReceptionCost } from './reception-cost.mjs';

assert.ok(process.argv[2], 'Usage: node reception-cost-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(process.argv[2]);
mkdirSync(directory);
const cases = [];
for (const children of [32, 128, 512]) {
  const baseline = await measureActionCost({ children });
  const candidate = measureReceptionCost({ children });
  cases.push({ children, baseline, candidate });
}
const files = ['examples/checkpoint-facts-study/reception-evidence.mjs', 'examples/checkpoint-facts-study/reception-cost.mjs', 'examples/checkpoint-facts-study/reception-cost-study.mjs', 'examples/checkpoint-facts-study/action-cost.mjs', 'examples/checkpoint-facts-study/action-boundaries.mjs', 'examples/checkpoint-facts-study/stable.mjs', 'examples/checkpoint-facts-study/fact-call.mjs', 'examples/checkpoint-facts-study/fact-store.mjs', 'server/invocation/src/invocation/relation.ts', 'server/invocation/src/checkpoint/invocation.ts', 'server/invocation/src/checkpoint/facts.ts'];
const sources = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify({ scope: 'Real Frame-v5 baseline vs isolated reception/fact model; deterministic counts, NOT production migration or end-to-end speedup', node: process.version, sources, cases }, null, 2)}\n`);
console.log(
  JSON.stringify(
    cases.map(({ children, baseline, candidate }) => ({ children, baselineSaveChecks: baseline.counts.receptionCheck, baselineOldChecks: baseline.counts.oldReceptionCheck, candidateSaveChecks: candidate.saveChecks, candidateOldChecks: candidate.oldSaveChecks, candidateEstablishment: candidate.counts.establishmentCheck, unchangedSave: candidate.unchangedSave })),
    null,
    2,
  ),
);
