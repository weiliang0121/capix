import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCheckpointValueBlock } from '@weiliang0121/capix-checkpoint';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { measureStorage } from '../examples/capacity/assembly.mjs';
import { analyzeFrames } from '../examples/capacity/diagnostics/analyze-frames.mjs';
import { distribution } from '../examples/capacity/measurement.mjs';
import { capacityPlan, validateCase } from '../examples/capacity/plan.mjs';
import { renderReport } from '../examples/capacity/report.mjs';

const suite = fileURLToPath(new URL('../examples/capacity/run.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../examples/capacity/worker.mjs', import.meta.url));
const transportComparison = fileURLToPath(new URL('../examples/capacity/transport.mjs', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-capacity-test-'));
  const active = new Set();
  const kill = (child) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  t.after(() => {
    for (const child of active) kill(child);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    async run(args) {
      const child = spawn(process.execPath, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG } });
      active.add(child);
      let output = '';
      let expired = false;
      const collect = (bytes) => {
        output = (output + bytes.toString()).slice(-24_000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        expired = true;
        kill(child);
      }, 45_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => resolve(code));
        });
        assert.equal(expired, false, `Capacity fixture timed out\n${output}`);
        assert.equal(code, 0, output);
        return output;
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) kill(child);
        active.delete(child);
      }
    },
  };
}

function result(directory) {
  return JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
}

for (const version of [1, 2, 3, 4, 5, 6, 7, 9]) {
  test(`capacity analysis refuses database version ${version} without changing the experiment`, (t) => {
    const { directory } = fixture(t);
    const path = join(directory, 'session-0.sqlite');
    const database = new DatabaseSync(path);
    try {
      database.exec(`PRAGMA application_id=1128353859; PRAGMA user_version=${version}; CREATE TABLE retained (body TEXT); INSERT INTO retained VALUES ('unchanged');`);
    } finally {
      database.close();
    }
    const before = readFileSync(path);
    assert.throws(() => analyzeFrames(path), /storage format 8/);
    assert.throws(() => measureStorage(directory), /storage format 8/);
    assert.deepEqual(readFileSync(path), before);
  });
}

test('capacity storage and diagnostics count and reconstruct v8 selections with retired occurrences', (t) => {
  const { directory } = fixture(t);
  const path = join(directory, 'session-0.sqlite');
  const store = ConversationStore.open(path);
  loadConversationContent(store);
  const value = createCheckpointValueBlock('input', null);
  const fixed = { id: value.id, digest: value.digest };
  const reference = { contextId: 'child', parentContextId: 'parent', parentRound: 1, order: 0, target: { position: 0 } };
  const commit = {
    kind: 'commit',
    formatVersion: 6,
    id: 'first',
    contract: { key: 'capacity-selection', version: 1 },
    point: 'waiting',
    frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: fixed, currentInput: fixed, nextChildOrder: 1 },
    state: fixed,
    references: { kind: 'slots', slots: { tools: { kind: 'many', selection: { id: 'tools', revision: 1, target: { position: 0 } } } } },
    values: [value],
    children: [{ identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, contract: { key: 'tool', version: 1 }, round: 1, order: 0, input: fixed, state: { kind: 'waiting' } }],
    selectionChanges: [
      {
        id: 'tools',
        target: { position: 0 },
        expectedRevision: 0,
        append: [
          { id: 'a', reference },
          { id: 'b', reference },
        ],
      },
    ],
  };
  let usage;
  let image;
  try {
    store.checkpoints.save(commit, 0);
    store.checkpoints.save({ ...commit, id: 'second', references: { kind: 'slots', slots: { tools: { kind: 'many', selection: { id: 'tools', revision: 2, target: { position: 0 } } } } }, values: [], children: [], selectionChanges: [{ id: 'tools', target: { position: 0 }, expectedRevision: 1, remove: [{ id: 'a', order: 0, reference }] }] }, 1);
    image = store.checkpoints.read('parent').image;
    usage = store.archiveUsage();
  } finally {
    store.close();
  }
  const storage = measureStorage(directory);
  assert.equal(storage.archiveJsonBytes, usage.totalBytes, 'independent accounting includes selection headers and live occurrence bodies');
  const report = analyzeFrames(path);
  assert.equal(report.storageFormat, 8);
  assert.equal(report.totals.jsonBytes, Buffer.byteLength(JSON.stringify(image)));
  assert.equal(report.totals.discardedBodies, 1);
  assert.deepEqual(image.references.tools, [reference]);
  const database = new DatabaseSync(path);
  try {
    database.exec('DELETE FROM checkpoint_occurrences WHERE body IS NULL');
  } finally {
    database.close();
  }
  assert.throws(() => analyzeFrames(path), /ordinal|occurrence|sequence/i, 'diagnostics preserve cold integrity checks for deleted occurrence identities');
});

test('transport comparison runs both policies serially in fresh workers and records the selected policy', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const out = join(f.directory, 'transport');
  await f.run([transportComparison, '--smoke', '--repeats', '1', '--out', out]);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.deepEqual(
    summary.map((entry) => entry.transport),
    ['direct', 'yield'],
  );
  for (const entry of summary) {
    assert.equal(entry.valid, true);
    assert.equal(entry.modelRequests, 8);
    assert.equal(entry.modelFailures, 0);
    assert.deepEqual(entry.reloads, { expected: 2, verified: 2 });
    assert.equal(result(join(out, entry.name)).config.transport, entry.transport);
  }
  const original = { ...capacityPlan({ smoke: true })[0] };
  delete original.transport;
  assert.equal(validateCase(original).transport, 'yield');
  assert.equal(original.transport, undefined, 'normalization does not change caller configuration');
  assert.throws(() => validateCase({ ...original, transport: 'retry' }), /transport/);
});

test('offline capacity smoke suite exercises all service profiles, steady arrivals, cancellation and clean persistence measurement', { timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const out = join(f.directory, 'suite');
  await f.run([suite, '--smoke', '--out', out]);
  const summaries = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summaries.length, 8);
  assert.ok(readFileSync(join(out, 'report.md'), 'utf8').includes('多会话容量实验'));
  for (const summary of summaries) {
    const value = result(join(out, summary.config.name));
    assert.equal(value.config.transport, 'yield');
    assert.equal(value.valid, true, JSON.stringify(value.failure));
    assert.deepEqual(value.residual, { runners: 0, interactions: 0, modelCalls: 0, upstreamRequests: 0, acquiredCalls: 0 });
    assert.equal(value.workload.failed, 0);
    assert.equal(value.models.failed, 0);
    assert.equal(value.models.requests, value.workload.acquired + value.workload.succeeded);
    assert.equal(value.upstream.requests, value.models.requests);
    assert.equal(value.upstream.completed, value.models.requests);
    assert.equal(value.upstream.failed, 0);
    assert.equal(value.upstream.aborted, 0, 'local cancellations do not abort independent model sends');
    assert.equal(value.rows.length, value.workload.offered);
    assert.equal(value.latencyMs.successfulCompletion.count, value.workload.succeeded);
    assert.ok(value.work.elapsedMs > 0);
    assert.ok(value.work.cpuMs >= 0);
    assert.ok(value.work.memory.peakSampled.rss > 0);
    assert.ok(value.models.requestBytes > 0);
    assert.ok(value.models.previewBytes > 0);
    for (const row of value.rows.filter((row) => row.status === 'succeeded')) {
      assert.equal(row.correctResult, true);
      assert.equal(row.correctPreview, true);
      assert.ok(row.firstDeltaMs >= 0);
      assert.ok(row.responseFromScheduleMs >= row.elapsedMs);
    }
    const profile = value.config.profile;
    assert.deepEqual(value.persistenceReloads, { expected: profile === 'memory' ? 0 : value.config.users, verified: profile === 'memory' ? 0 : value.config.users });
    assert.equal(value.storage.databases, profile === 'memory' ? 0 : value.config.users);
    assert.equal(value.storage.tables.checkpoint_images > 0, ['checkpoint', 'recording'].includes(profile));
    if (profile !== 'memory') {
      assert.equal(
        value.storage.tables.messages,
        value.content.reduce((total, content) => total + content.messages, 0),
      );
      assert.equal(value.storage.tables.completion_interactions, value.models.requests);
      assert.ok(value.storage.databaseBytes > 0);
      assert.equal(value.storage.walBytes, 0);
      assert.equal(value.storage.shmBytes, 0);
      assert.equal(value.storage.tables.model_exchanges, 0);
      assert.equal(value.storage.tables.model_exchange_entries, 0);
      assert.equal(value.storage.checkpointRetainedBodies, value.storage.tables.checkpoint_heads);
      assert.equal(value.storage.checkpointRetainedBodies + value.storage.checkpointDiscardedBodies, value.storage.tables.checkpoint_images);
      assert.equal(value.storage.archiveJsonBytes, value.storage.checkpointJsonBytes + value.storage.checkpointValueJsonBytes + value.storage.checkpointMetadataBytes + value.storage.deliveryJsonBytes + value.storage.interactionStoredBytes + value.storage.exchangeStoredBytes + value.storage.exchangeMetadataBytes);
    }
    for (const content of value.content) {
      assert.equal(content.reloadVerified, profile !== 'memory');
      assert.equal(content.memories, 1, 'empty model proposals preserve the seeded fact');
      assert.equal(content.recordingStatus, profile === 'recording' ? 'recording' : 'idle');
      if (profile === 'recording') assert.equal(content.recordingIntegrity, 'intact');
    }
  }
  const churn = summaries.find((value) => value.config.pattern === 'churn');
  assert.equal(churn.workload.offered, 4);
  assert.equal(churn.workload.cancelled, 1);
  assert.equal(churn.workload.detachedDisplays, 1);
  assert.equal(churn.workload.succeeded, 3);
  assert.equal(churn.models.requests, 7);
  const bursts = summaries.filter((value) => value.config.pattern === 'burst');
  for (const value of bursts) assert.equal(value.workload.peakLocalCalls, value.config.users);

  // SQL measurement must not change the disk state it reports.
  const closed = join(out, 'checkpoint-burst-4');
  const before = readdirSync(closed).sort();
  const measured = measureStorage(closed);
  const frames = analyzeFrames(join(closed, 'session-0.sqlite'));
  assert.equal(frames.storageFormat, 8);
  assert.equal(frames.totals.retainedBodies, frames.totals.heads);
  assert.ok(frames.totals.discardedBodies > 0);
  assert.equal(frames.totals.imageIdentities, frames.totals.retainedBodies + frames.totals.discardedBodies);
  assert.deepEqual(readdirSync(closed).sort(), before);
  assert.equal(measured.walBytes, 0);
  const wal = join(closed, 'session-0.sqlite-wal');
  assert.equal(existsSync(wal), false);
  writeFileSync(wal, 'uncheckpointed-fixture', { flag: 'wx' });
  assert.throws(() => measureStorage(closed), /nonempty WAL/);
  rmSync(wal);
  assert.deepEqual(measureStorage(closed), measured);
});

test('fixed-rate arrivals expose busy rejections instead of waiting or counting them as successful completions', { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  const directory = join(f.directory, 'busy');
  mkdirSync(directory);
  const config = validateCase({ name: 'busy', profile: 'memory', pattern: 'steady', users: 1, rounds: 1, historyBytes: 128, durationSeconds: 1, rate: 20, model: { answerMs: 200, chunks: 4, outputBytes: 128, memoryMs: 10 } });
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config), { flag: 'wx' });
  await f.run(['--expose-gc', worker, directory]);
  const value = result(directory);
  assert.equal(value.valid, true);
  assert.equal(value.workload.offered, 20);
  assert.ok(value.workload.rejected > 0);
  assert.ok(value.workload.succeeded > 0);
  assert.equal(value.workload.succeeded + value.workload.rejected, 20);
  assert.equal(value.workload.acquired, value.workload.succeeded);
  assert.equal(value.models.requests, value.workload.succeeded * 2);
  assert.equal(value.latencyMs.firstDelta.count, value.workload.succeeded, 'missing preview samples are not zero-latency successes');
  assert.ok(value.rows.filter((row) => row.status === 'rejected').every((row) => row.firstDeltaMs === null && row.acquiredMs === null));
  assert.deepEqual(value.residual, { runners: 0, interactions: 0, modelCalls: 0, upstreamRequests: 0, acquiredCalls: 0 });
});

test('capacity plans remain bounded and percentile samples exclude absent measurements', () => {
  const plan = capacityPlan();
  assert.deepEqual(
    plan.filter((value) => value.profile === 'memory' && value.pattern === 'burst').map((value) => value.users),
    [10, 50, 100, 200],
  );
  assert.throws(() => capacityPlan({ users: [200, 100] }));
  assert.throws(() => capacityPlan({ users: [501] }));
  assert.throws(() => capacityPlan({ durationSeconds: 601 }));
  assert.throws(() => validateCase({ ...plan[0], model: { ...plan[0].model, chunks: 0 } }));
  assert.deepEqual(distribution([null, undefined, NaN, Infinity]), { count: 0, min: null, p50: null, p95: null, p99: null, max: null });
  const measured = distribution([10, null, 20, 30, Infinity]);
  assert.equal(measured.count, 3);
  assert.equal(measured.p50, 20);
  assert.equal(measured.max, 30);
});

test('capacity reports distinguish image identities from retained bodies without inventing unmeasured counts', () => {
  const storage = { databases: 1, totalBytes: 4096, tables: { checkpoint_images: 3, completion_interactions: 1 }, checkpointStoredBytes: 128, checkpointJsonBytes: 256 };
  const cases = [
    { config: { name: 'unmeasured' }, storage },
    { config: { name: 'head-only' }, storage: { ...storage, checkpointRetainedBodies: 1, checkpointDiscardedBodies: 2 } },
  ];
  const report = renderReport({ cases }, cases);
  assert.match(report, /CP 身份行\/保留正文\/淘汰正文/);
  assert.match(report, /3\/未测量\/未测量/);
  assert.match(report, /3\/1\/2/);
  assert.match(report, /文件尺寸与保留 JSON 存量都不是累计写入字节/);
});
