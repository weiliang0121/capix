import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LifecycleAdapter } from './lifecycle-adapter.mjs';
import { lifecycleBinding, lifecycleReception } from './invocation-lifecycle.mjs';
import { LifecycleFacts } from './lifecycle-facts.mjs';

// Deliberately a counting experiment, not a timing benchmark. The existing
// Invocation still captures/validates all children to produce the v5 oracle.
async function measure(directory, count) {
  const adapter = new LifecycleAdapter({ path: join(directory, `lifecycle-${count}.sqlite`) });
  const counts = {};
  function codec(name) {
    counts[name] = { encode: 0, decode: 0 };
    return {
      encode(value) {
        counts[name].encode++;
        return value;
      },
      decode(value) {
        counts[name].decode++;
        return value;
      },
    };
  }
  const childBinding = { ...lifecycleBinding('study.count.child'), input: codec('childInput'), output: codec('childOutput') };
  const reception = { ...lifecycleReception(), codec: codec('reception') };
  const binding = { ...lifecycleBinding('study.count.parent', { children: [{ kind: 'node', binding: childBinding }], receptions: [reception] }), input: codec('parentInput'), output: codec('parentOutput') };
  const samples = [];
  let previous = new Map();
  let parentSaves = 0;
  function save(invocation, index, phase) {
    invocation.checkpointWriter.save('checkpoint', { index, phase });
    const model = adapter.models.get(invocation.context.id);
    const current = model.encodingCounts();
    let oldReencodings = 0;
    // Measurement bookkeeping is an explicit full scan, outside the measured
    // representation. Do not count this loop as an incremental implementation.
    for (const [id, encoded] of previous) oldReencodings += current.get(id) - encoded;
    previous = current;
    parentSaves++;
    samples.push({ index, phase, oldReencodings, factsEncoded: current.size, headBytes: Buffer.byteLength(JSON.stringify(adapter.facts.readHead(invocation.context.id))) });
  }
  try {
    const parent = adapter.create({
      input: { material: 'fixed' },
      binding,
      async execute(_context, invocation) {
        for (let index = 0; index < count; index++) {
          const child = adapter.create({
            parent: invocation,
            key: 'repeat',
            input: { index },
            binding: childBinding,
            execute(_childContext, childInvocation) {
              childInvocation.checkpointWriter.save('checkpoint', { index });
              return { index };
            },
          });
          save(invocation, index, 'waiting');
          await child.run();
          await invocation.children.get(child).accept((value) => ({ accepted: value.index }), reception);
          save(invocation, index, 'accepted');
        }
        return { count };
      },
    });
    assert.deepEqual(await parent.run(), { count });
    const model = adapter.models.get(parent.context.id);
    const encodings = model.encodingCounts();
    assert.ok([...encodings.values()].every((value) => value === 1));
    assert.ok(samples.every((sample) => sample.oldReencodings === 0));
    const hot = {
      parentSaves,
      parentBoundaries: model.stats.boundaries,
      parentFactsEncoded: encodings.size,
      oldBoundaryReencodings: 0,
      parentOracleChildren: adapter.comparisons.filter((comparison) => comparison.contextId === parent.context.id).reduce((sum, comparison) => sum + comparison.children, 0),
      candidateProjectedChildren: model.stats.projectedChildren,
      candidateProjections: model.stats.projections,
      storeOldBodyReads: adapter.facts.stats.oldBodyReads,
      codecs: structuredClone(counts),
      headBytes: { min: Math.min(...samples.map((sample) => sample.headBytes)), max: Math.max(...samples.map((sample) => sample.headBytes)) },
    };
    const before = adapter.facts.stats.oldBodyReads;
    const cold = LifecycleFacts.reopen(adapter.facts, parent.context.id);
    assert.deepEqual(cold.readHead(), model.readHead());
    return { count, hot, cold: { factBodyReads: adapter.facts.stats.oldBodyReads - before, boundaries: cold.stats.coldBoundaries }, samples };
  } finally {
    adapter.close();
  }
}

const destination = process.argv[2];
assert.ok(destination, 'Usage: node lifecycle-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(destination);
mkdirSync(directory);
const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['examples/checkpoint-facts-study/lifecycle-study.mjs', 'examples/checkpoint-facts-study/lifecycle-adapter.mjs', 'examples/checkpoint-facts-study/lifecycle-facts.mjs', 'examples/checkpoint-facts-study/fact-call.mjs', 'examples/checkpoint-facts-study/fact-store.mjs', 'examples/checkpoint-facts-study/stable.mjs', 'server/invocation/src/invocation/invocation.ts', 'server/invocation/src/invocation/relation.ts', 'server/invocation/src/checkpoint/invocation.ts', 'server/invocation/src/checkpoint/children.ts', 'server/checkpoint/src/value.ts', 'server/checkpoint/src/receipt.ts'];
const cases = [];
for (const count of [32, 128]) cases.push(await measure(directory, count));
const summary = {
  scope: 'real Invocation with isolated stable lifecycle storage; complete v5 oracle retained; not a production migration or timing benchmark',
  node: process.version,
  sources: Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex'),
    ]),
  ),
  cases,
};
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    cases.map(({ samples: _samples, ...result }) => result),
    null,
    2,
  ),
);
