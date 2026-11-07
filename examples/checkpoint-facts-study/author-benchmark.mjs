import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactCall } from './fact-call.mjs';
import { FactStore, hash, identity } from './fact-store.mjs';

const difference = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sourceHashes = () => Object.fromEntries(['fact-call.mjs', 'fact-store.mjs', 'stable.mjs', 'author-benchmark.mjs'].map((name) => [name, hash(readFileSync(new URL(name, import.meta.url), 'utf8'))]));

export function runAuthorBenchmark({ children, mode = 'bounded' }, path = ':memory:') {
  const store = new FactStore(path);
  try {
    const call = new FactCall(store, identity('parent'), { text: 'x'.repeat(50 * 1024) });
    const rows = [];
    const history = [];
    const check = (state, facts) => {
      assert.equal(facts.relationCount('tool', 'tool@1'), state.step);
      assert.equal(facts.referenceSize('history'), state.step);
      const latest = facts.latestRelation('tool', 'tool@1');
      assert.equal(latest.identity.order, state.step);
      if (state.phase === 'waiting') {
        assert.deepEqual(facts.referenceOf('active'), latest.identity);
        assert.equal(latest.phase, 'waiting');
      } else {
        assert.equal(facts.referenceOf('active'), undefined);
        assert.equal(latest.phase, 'accepted');
        assert.deepEqual(facts.value(latest.output), facts.value(latest.received));
      }
      for (const event of facts.changes().events) if (event.type === 'relation') assert.equal(event.value.identity.position, 'tool');
      if (mode === 'enumerate') for (const child of facts.references('history')) assert.equal(facts.relation(child).identity.contract, 'tool@1');
    };
    const save = (phase, step) => {
      const beforeCall = { ...call.stats };
      const beforeStore = { ...store.stats };
      const before = performance.now();
      call.save(phase, { phase, step, ...(mode === 'inline-history' ? { history } : {}) }, { check });
      const elapsedMs = performance.now() - before;
      rows.push({ phase, step, elapsedMs, call: difference(call.stats, beforeCall), store: difference(store.stats, beforeStore) });
    };
    for (let step = 1; step <= children; step++) {
      const child = call.createChild(`child-${step}`, { step }, { position: 'tool', contract: 'tool@1' });
      call.addReference('history', child);
      call.reference('active', child);
      history.push(child.contextId);
      save('waiting', step);
      const value = { text: 'y'.repeat(64), step };
      call.returned(child, value);
      call.receive(child, value);
      call.clearReference('active');
      save('accepted', step);
    }
    const head = store.readHead('parent');
    const beforeNoop = { call: { ...call.stats }, store: { ...store.stats } };
    save('accepted', children);
    const noop = rows.pop();
    assert.equal(call.stats.encodedFacts - beforeNoop.call.encodedFacts, 0);
    const totals = { call: { ...call.stats }, store: { ...store.stats } };
    const tail = rows.slice(-Math.max(2, Math.ceil(rows.length / 10)));
    return {
      config: { children, mode },
      summary: { saveMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0), tailP50Ms: median(tail.map((row) => row.elapsedMs)), headBytes: Buffer.byteLength(JSON.stringify(head)), stateBytes: Buffer.byteLength(head.state), metadataEvents: totals.store.metadataEvents, referenceScans: totals.call.referenceScans, oldBodyReads: totals.store.oldBodyReads },
      totals,
      noop,
      rows,
    };
  } finally {
    store.close();
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--worker') {
    const sources = sourceHashes();
    const result = runAuthorBenchmark(JSON.parse(process.argv[3]), process.argv[4]);
    assert.deepEqual(sourceHashes(), sources, 'Sources changed during worker');
    writeFileSync(process.argv[5], JSON.stringify({ sources, ...result }));
  } else if (process.argv[2] === '--run') {
    const directory = resolve(process.argv[3]);
    mkdirSync(directory); // Never overwrite another experiment.
    const sources = sourceHashes();
    const configs = [...[32, 128, 512, 2048].map((children) => ({ children, mode: 'bounded' })), { children: 128, mode: 'enumerate' }, { children: 128, mode: 'inline-history' }];
    const rows = [];
    for (const config of configs) {
      for (let run = 1; run <= 3; run++) {
        const name = `${config.mode}-${config.children}-${run}`;
        const output = join(directory, `${name}.json`);
        const worker = spawnSync(process.execPath, [self, '--worker', JSON.stringify(config), join(directory, `${name}.sqlite`), output], { encoding: 'utf8' });
        assert.equal(worker.status, 0, worker.stderr || worker.stdout);
        const result = JSON.parse(readFileSync(output, 'utf8'));
        assert.deepEqual(result.sources, sources, 'Workers did not use the same sources');
        rows.push({ name, ...result.config, ...result.summary });
        process.stdout.write(`${name}: ${result.summary.saveMs.toFixed(2)} ms, ${result.summary.headBytes} head bytes\n`);
      }
    }
    assert.deepEqual(sourceHashes(), sources, 'Sources changed during study');
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({ node: process.version, sources, rows }, null, 2));
  } else throw new Error('Use --run NEW_DIRECTORY');
}
