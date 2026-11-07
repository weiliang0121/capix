import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { measurePointLayouts } from './point-layout-cost.mjs';

assert.ok(process.argv[2], 'Usage: node point-layout-cost-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(process.argv[2]);
mkdirSync(directory);
const cases = [32, 128, 512, 2048].map((children) => measurePointLayouts({ children, switches: 30 }));
const files = ['point-facts.mjs', 'saved-facts.mjs', 'fact-call.mjs', 'fact-store.mjs', 'reception-evidence.mjs', 'point-layout-cost.mjs', 'point-layout-cost-study.mjs'].map((name) => `examples/checkpoint-facts-study/${name}`);
const sources = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify({ scope: 'Point projection and shared authentication model; no production timing or automatic draft recovery', node: process.version, sources, cases }, null, 2)}\n`);
console.log(JSON.stringify(cases, null, 2));
