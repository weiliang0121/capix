import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { FactStore, hash, identity, stableCodec } from './fact-store.mjs';
import { FactCall } from './fact-call.mjs';
import { StableValues } from './stable.mjs';

const script = fileURLToPath(import.meta.url);
const sourceFingerprints = () => Object.fromEntries(['fact-benchmark.mjs', 'fact-call.mjs', 'fact-store.mjs', 'stable.mjs'].map((name) => [name, hash(readFileSync(new URL(name, import.meta.url), 'utf8'))]));
const difference = (after, before) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const quantile = (values, percentile) => [...values].sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * percentile) - 1)];
const timing = (rows, name) => ({
  total: sum(rows.map((row) => row[name])),
  p50: quantile(
    rows.map((row) => row[name]),
    0.5,
  ),
  p95: quantile(
    rows.map((row) => row[name]),
    0.95,
  ),
  max: Math.max(...rows.map((row) => row[name])),
});

// Counts are exact statements/entries under this experimental implementation;
// elapsed times describe this machine, SQLite FULL mode, and this process only.
// No equivalence with Frame v5, production compression or Runner is claimed.
export function runFactBenchmark(config, database) {
  const store = new FactStore(database);
  const values = new StableValues();
  const root = new FactCall(store, identity('root'), { material: 'h'.repeat(config.inputBytes) }, { values });
  const children = [];
  const rows = [];
  const fullCheck =
    config.mode === 'full-check'
      ? (state, facts) => {
          for (const relation of facts.allRelations()) {
            if (relation.output !== null) facts.value(relation.output);
            if (relation.received !== null) facts.value(relation.received);
          }
        }
      : () => {};
  const step = (index, phase, prepare) => {
    const beforeCall = { ...root.stats };
    const beforeStore = { ...store.stats };
    const start = performance.now();
    prepare();
    if (config.mode === 'rewrite-refs') for (const child of children) root.reference(`slot-${child.order}`, child);
    const saveStart = performance.now();
    const beforeSave = { ...root.stats };
    root.save(phase, { step: index }, { check: fullCheck });
    const finish = performance.now();
    rows.push({ index, phase, preparationMs: saveStart - start, saveMs: finish - saveStart, stepMs: finish - start, call: difference(root.stats, beforeCall), saveCall: difference(root.stats, beforeSave), store: difference(store.stats, beforeStore) });
  };
  try {
    for (let index = 1; index <= config.children; index++) {
      let child;
      step(index, 'waiting', () => {
        child = root.createChild(`child-${String(index).padStart(6, '0')}`, { index });
        children.push(child);
        root.reference(`slot-${child.order}`, child);
      });
      step(index, 'accepted', () => {
        const output = { text: 'v'.repeat(config.outputBytes) };
        root.returned(child, output);
        root.receive(child, output);
      });
    }
    const beforeCall = { ...root.stats };
    const beforeStore = { ...store.stats };
    const start = performance.now();
    root.save('accepted', { step: config.children });
    const noChange = { saveMs: performance.now() - start, call: difference(root.stats, beforeCall), store: difference(store.stats, beforeStore) };
    assert.equal(noChange.call.encodedFacts, 0);
    assert.equal(noChange.call.factReads, 0);
    assert.equal(noChange.store.metadataEvents, 0);
    assert.equal(noChange.store.oldBodyReads, 0);
    assert.equal(noChange.call.stateEncodes, 1);
    const totals = { call: { ...root.stats }, store: { ...store.stats }, fixingVisits: values.visits };
    assert.equal(totals.call.encodedFacts, config.children * 3 + 1);
    assert.equal(totals.store.factsWritten, config.children * 3 + 1);
    assert.equal(totals.store.oldBodyReads, 0);
    assert.equal(totals.call.stateEncodes, config.children * 2 + 1);
    for (const row of rows) {
      assert.equal(row.saveCall.encodedFacts, row.phase === 'waiting' ? (row.index === 1 ? 2 : 1) : 2);
      if (config.mode !== 'full-check') assert.equal(row.saveCall.factReads, 0);
    }
    return { config, rows, totals, noChange, summary: summarizeRows(rows, config.children) };
  } finally {
    store.close();
  }
}

function summarizeRows(rows, count) {
  const result = {};
  for (const [name, selected] of [
    ['all', rows],
    ['first', rows.filter((row) => row.index <= Math.max(1, Math.ceil(count / 10)))],
    ['middle', rows.filter((row) => row.index >= Math.max(1, Math.ceil(count * 0.45)) && row.index <= Math.ceil(count * 0.55))],
    ['last', rows.filter((row) => row.index > Math.floor(count * 0.9))],
  ]) {
    result[name] = {
      saves: selected.length,
      saveMs: timing(selected, 'saveMs'),
      preparationMs: timing(selected, 'preparationMs'),
      stepMs: timing(selected, 'stepMs'),
      medianEncodedFacts: quantile(
        selected.map((row) => row.saveCall.encodedFacts),
        0.5,
      ),
      medianMetadataReads: quantile(
        selected.map((row) => row.store.metadataReads),
        0.5,
      ),
      maxMetadataReads: Math.max(...selected.map((row) => row.store.metadataReads)),
      medianEvents: quantile(
        selected.map((row) => row.store.metadataEvents),
        0.5,
      ),
      maxEvents: Math.max(...selected.map((row) => row.store.metadataEvents)),
      medianHeadBytes: quantile(
        selected.map((row) => row.store.headBytesWritten),
        0.5,
      ),
      maxHeadBytes: Math.max(...selected.map((row) => row.store.headBytesWritten)),
      authorBodyReads: sum(selected.map((row) => row.saveCall.factReads)),
      authoredRelationScans: sum(selected.map((row) => row.saveCall.authoredScans)),
    };
  }
  return result;
}

function restoreFactBenchmark(database) {
  const store = new FactStore(database);
  const values = new StableValues();
  const codec = stableCodec(values);
  try {
    const start = performance.now();
    const restored = store.restore('root', new Map([[codec.key, codec]]));
    const elapsedMs = performance.now() - start;
    return { elapsedMs, stats: { ...store.stats }, fixingVisits: values.visits, facts: restored.values.size, relations: restored.relations.size, refs: restored.refs.size, events: restored.head.cursor, revision: restored.head.revision, status: restored.head.status };
  } finally {
    store.close();
  }
}

function invoke(args) {
  const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, `${args[0]} failed\n${child.stderr}\n${child.stdout}`);
  return child.stdout.trim() ? JSON.parse(child.stdout) : undefined;
}

function runStudy(directory) {
  mkdirSync(directory, { recursive: false });
  const cases = [...[32, 128, 512, 2048].map((children) => ({ name: `n${children}`, children, inputBytes: 50 * 1024, outputBytes: 64, mode: 'incremental' })), { name: 'input500k', children: 128, inputBytes: 500 * 1024, outputBytes: 64, mode: 'incremental' }, { name: 'output16k', children: 128, inputBytes: 50 * 1024, outputBytes: 16 * 1024, mode: 'incremental' }, { name: 'full-check', children: 128, inputBytes: 50 * 1024, outputBytes: 64, mode: 'full-check' }, { name: 'rewrite-refs', children: 128, inputBytes: 50 * 1024, outputBytes: 64, mode: 'rewrite-refs' }];
  const runs = [];
  for (const config of cases) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      const name = `${config.name}-${repeat}`;
      const prefix = join(directory, name);
      const path = `${prefix}.config.json`;
      writeFileSync(path, JSON.stringify({ config, database: `${prefix}.sqlite`, output: `${prefix}.json` }));
      const run = invoke(['--case', path]);
      runs.push({ name, ...run });
      process.stdout.write(`${name}: saves=${run.summary.all.saves} saveMs=${run.summary.all.saveMs.total.toFixed(1)} lastP50=${run.summary.last.saveMs.p50.toFixed(3)} restoreMs=${run.restore.elapsedMs.toFixed(1)}\n`);
    }
  }
  const summary = { format: 'fact-head-benchmark@1', createdAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, sqlite: 'WAL/FULL; one fresh DB and worker per case; separate restore process', measurements: 'saveMs includes full FactCall.save; preparationMs includes returned/acceptance/reference setup. Bytes are logical UTF-8 payloads, not physical SQL writes. Cold restore performs all facts/events checks. Prototype has no production Frame-v5 compression, resource/call lifecycle, or real model.', runs };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === '--restore') process.stdout.write(JSON.stringify(restoreFactBenchmark(argument)));
  else if (mode === '--case') {
    const { config, database, output } = JSON.parse(readFileSync(argument, 'utf8'));
    const sources = sourceFingerprints();
    const result = runFactBenchmark(config, database);
    result.restore = invoke(['--restore', database]);
    assert.deepEqual(sourceFingerprints(), sources, 'Experiment sources changed during worker/restore');
    result.sources = sources;
    assert.equal(result.restore.facts, config.children * 3 + 1);
    assert.equal(result.restore.relations, config.children);
    assert.equal(result.restore.refs, config.children);
    result.databaseBytes = statSync(database).size;
    writeFileSync(output, JSON.stringify(result, null, 2));
    const { rows, ...summary } = result;
    process.stdout.write(JSON.stringify(summary));
  } else if (mode === '--run') runStudy(resolve(argument ?? `.capix/fact-head-study-${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`));
  else process.stdout.write('Usage: node examples/checkpoint-facts-study/fact-benchmark.mjs --run [new-output-directory]\n');
}
