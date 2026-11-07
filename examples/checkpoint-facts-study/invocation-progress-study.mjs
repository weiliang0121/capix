import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactCall } from './fact-call.mjs';
import { FactStore, identity, stableCodec } from './fact-store.mjs';
import { LocalProgress } from './local-progress.mjs';
import { StableValues } from './stable.mjs';

// Counts only this explicit call-local selection policy. It is not a production
// Invocation benchmark, nor a bound on arbitrary state, checks, or model input.
function measure(directory, count) {
  const store = new FactStore(join(directory, `local-${count}.sqlite`));
  try {
    const call = new FactCall(store, identity('parent'), { input: 'fixed' });
    const progress = new LocalProgress(call);
    const samples = [];
    let prefix = null;
    let state;
    for (let index = 0; index < count; index++) {
      const key = String(index).padStart(4, '0');
      const before = call.stats.encodedFacts;
      const previous = new Map(call.encodings);
      prefix = progress.append(prefix, { key, revision: 1, calls: [{ id: `${key}:a` }, { id: `${key}:b` }], content: { text: key } });
      state = { prefix, current: { key, revision: 1 }, cursor: 0, active: null };
      progress.save('processing', state);
      let oldEncodings = 0;
      for (const [id, encoded] of previous) oldEncodings += call.encodings.get(id) - encoded;
      samples.push({ index, newEncodings: call.stats.encodedFacts - before, oldEncodings, headBytes: Buffer.byteLength(JSON.stringify(store.readHead('parent'))) });
    }
    const beforeSame = { ...call.stats };
    progress.save('processing', { ...state, cursor: 1, active: `${state.current.key}:b` });
    const sameToken = { encodings: call.stats.encodedFacts - beforeSame.encodedFacts, factReads: call.stats.factReads - beforeSame.factReads, checks: call.stats.checks - beforeSame.checks };
    const hot = { facts: call.stats.encodedFacts, factReads: call.stats.factReads, oldBodyReads: store.stats.oldBodyReads, nodeChecks: progress.stats.nodeChecks, combinationChecks: progress.stats.headChecks };
    assert.equal(progress.materialize(prefix).length, count);
    const beforeRestore = store.stats.oldBodyReads;
    const values = new StableValues();
    const codec = stableCodec(values);
    const restored = store.restore('parent', new Map([[codec.key, codec]]));
    const coldCall = new FactCall(store, restored.head.identity, undefined, { values, codec, restored });
    const coldProgress = new LocalProgress(coldCall);
    coldProgress.check(restored.head.point, restored.state);
    return {
      count,
      hot,
      sameToken,
      headBytes: { min: Math.min(...samples.map((entry) => entry.headBytes)), max: Math.max(...samples.map((entry) => entry.headBytes)) },
      materializedNodes: progress.stats.materializedNodes,
      cold: { bodyReads: store.stats.oldBodyReads - beforeRestore, nodeChecks: coldProgress.stats.nodeChecks, combinationChecks: coldProgress.stats.headChecks },
      samples,
    };
  } finally {
    store.close();
  }
}

const destination = process.argv[2];
assert.ok(destination, 'Usage: node invocation-progress-study.mjs NEW_OUTPUT_DIRECTORY');
const directory = resolve(destination);
mkdirSync(directory); // Refuse an existing result directory.
const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['examples/checkpoint-facts-study/invocation-progress-study.mjs', 'examples/checkpoint-facts-study/local-progress.mjs', 'examples/checkpoint-facts-study/fact-call.mjs', 'examples/checkpoint-facts-study/fact-store.mjs', 'examples/checkpoint-facts-study/stable.mjs', 'server/invocation/src/invocation/invocation.ts', 'server/invocation/src/invocation/relation.ts', 'server/invocation/src/checkpoint/children.ts'];
const summary = {
  scope: 'isolated call-local selection; no production migration',
  node: process.version,
  sources: Object.fromEntries(
    sources.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex'),
    ]),
  ),
  cases: [32, 128].map((count) => measure(directory, count)),
};
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    summary.cases.map(({ samples: _samples, ...result }) => result),
    null,
    2,
  ),
);
