import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measureSavedFacts } from './saved-facts-cost.mjs';

assert.ok(process.argv[2], 'Usage: node saved-facts-cost-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(process.argv[2]);
mkdirSync(directory);
const cases = [];
for (const children of [32, 128, 512]) {
  for (const options of [{ mode: 'none' }, { mode: 'current' }, { mode: 'all' }, { mode: 'current', eager: true }]) cases.push(measureSavedFacts({ children, ...options }));
}
cases.push(measureSavedFacts({ children: 2048, mode: 'current' }));
const files = ['examples/checkpoint-facts-study/saved-facts.mjs', 'examples/checkpoint-facts-study/saved-facts-cost.mjs', 'examples/checkpoint-facts-study/saved-facts-cost-study.mjs', 'examples/checkpoint-facts-study/reception-evidence.mjs', 'examples/checkpoint-facts-study/fact-call.mjs', 'examples/checkpoint-facts-study/fact-store.mjs', 'examples/checkpoint-facts-study/stable.mjs', 'server/runtime/src/binding/checkpoint.ts'];
const sources = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify({ scope: 'Query adaptation on isolated fact model; eager source-equivalent control, NOT production timing or universal O(1)', node: process.version, sources, cases }, null, 2)}\n`);
console.log(
  JSON.stringify(
    cases.map(({ config, saves, view, authorRows, reception, noNewFacts }) => ({ config, saves, view, authorRows, reception, noNewFacts })),
    null,
    2,
  ),
);
