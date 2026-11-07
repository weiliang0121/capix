import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measureActionCost } from './action-cost.mjs';

assert.ok(process.argv[2], 'Usage: node action-cost-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(process.argv[2]);
mkdirSync(directory);
const cases = [];
for (const children of [32, 128, 512]) cases.push(await measureActionCost({ children }));
cases.push(await measureActionCost({ children: 128, draftEdits: 1000 }));
cases.push(await measureActionCost({ children: 128, resource: true }));
cases.push(await measureActionCost({ children: 128, resource: true, checkpoints: false }));
const files = ['examples/checkpoint-facts-study/action-cost.mjs', 'examples/checkpoint-facts-study/action-boundaries.mjs', 'examples/checkpoint-facts-study/stable.mjs', 'server/invocation/src/checkpoint/invocation.ts', 'server/invocation/src/checkpoint/children.ts', 'server/invocation/src/checkpoint/facts.ts', 'server/checkpoint/src/value.ts'];
const sources = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const summary = { scope: 'Real Invocation/Frame v5, explicit stable handoffs in fixture, exact callback/entry counts; no wall-clock speedup or production migration claim', node: process.version, sources, cases };
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    cases.map(({ samples, ...entry }) => entry),
    null,
    2,
  ),
);
