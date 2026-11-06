import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';

const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, repeats: { type: 'string', default: '3' }, measure: { type: 'string' }, help: { type: 'boolean' } } });

if (values.help) {
  console.log('node examples/tool-host-study/retention.mjs --source CLOSED_EXPERIMENT_V5.sqlite --out NEW_DIRECTORY [--repeats 3]\n只复制已关闭的 v5 实验库；在副本测量 v6 迁移与再次打开。原文件只读，不运行模型、不执行调用、不 VACUUM。');
} else if (values.measure) {
  // A fresh child per phase isolates maximum RSS from earlier scans and trials.
  global.gc?.();
  const before = process.memoryUsage();
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  const store = ConversationStore.open(values.measure);
  const opened = performance.now();
  let usage;
  try {
    usage = store.archiveUsage();
  } finally {
    store.close();
  }
  const finished = performance.now();
  const cpu = process.cpuUsage(cpuStarted);
  const after = process.memoryUsage();
  console.log(JSON.stringify({ openMs: opened - started, closeAndUsageMs: finished - opened, totalMs: finished - started, cpuMs: (cpu.user + cpu.system) / 1000, rssBeforeBytes: before.rss, rssAfterBytes: after.rss, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, heapBeforeBytes: before.heapUsed, heapAfterBytes: after.heapUsed, usage }));
} else {
  if (!values.source || !values.out) throw new Error('--source and --out are required');
  if (!/^[1-9]\d*$/.test(values.repeats) || Number(values.repeats) > 10) throw new Error('--repeats must be 1–10');
  const source = resolve(values.source);
  const output = resolve(values.out);
  await assertClosed(source);
  const sourceDigest = await digestFile(source);
  await mkdir(output, { recursive: false, mode: 0o700 });
  // Even a read-only SQLite connection can create WAL/SHM sidecars. Inspect a
  // separate reference copy, never open the source with SQLite at all.
  const reference = join(output, 'reference.sqlite');
  await copyFile(source, reference, constants.COPYFILE_EXCL);
  assert.equal(await digestFile(reference), sourceDigest, 'The source changed while copying');
  const before = snapshot(reference);
  if (before.version !== 5) throw new Error('Source must be a v5 experiment database');
  const results = [];
  for (let index = 1; index <= Number(values.repeats); index++) {
    await assertClosed(source);
    const path = join(output, `trial-${index}.sqlite`);
    await copyFile(source, path, constants.COPYFILE_EXCL);
    assert.equal(await digestFile(path), sourceDigest, 'The source changed while copying');
    const fileBeforeBytes = (await stat(path)).size;
    const migration = measure(path);
    const after = snapshot(path);
    assert.equal(after.version, 6);
    assert.equal(after.identitiesDigest, before.identitiesDigest, 'Image identities or revisions changed');
    assert.equal(after.headsDigest, before.headsDigest, 'Current head bodies or deliveries changed');
    assert.equal(after.otherFactsDigest, before.otherFactsDigest, 'Content, interactions or tool exchanges changed');
    assert.equal(after.retention.retainedBodies, after.retention.heads);
    assert.equal(after.retention.imageIdentities, before.retention.imageIdentities);
    assert.equal(after.usage.checkpoint_bytes, before.currentCheckpointBytes);
    const fileAfterBytes = (await stat(path)).size;
    const reopen = measure(path);
    assert.deepEqual(snapshot(path), after, 'Reopening a v6 database changed its facts');
    assert.deepEqual(reopen.usage, migration.usage);
    results.push({ trial: index, migration, reopen, fileBeforeBytes, fileAfterBytes, before: before.retention, after: after.retention, verified: true });
    console.log(`第 ${index} 次：迁移 ${migration.totalMs.toFixed(1)} ms，再次打开 ${reopen.totalMs.toFixed(1)} ms，正文 ${before.retention.retainedBodies} → ${after.retention.retainedBodies}`);
  }
  await assertClosed(source);
  assert.equal(await digestFile(source), sourceDigest, 'The source must remain byte-for-byte unchanged');
  const summary = { formatVersion: 1, source, sourceSha256: sourceDigest, node: process.version, platform: process.platform, architecture: process.arch, repeats: results.length, retainedFacts: before, results, median: { migrationMs: median(results.map((result) => result.migration.totalMs)), migrationCpuMs: median(results.map((result) => result.migration.cpuMs)), reopenMs: median(results.map((result) => result.reopen.totalMs)), reopenCpuMs: median(results.map((result) => result.reopen.cpuMs)) }, note: 'Each phase uses a fresh process; timings exclude imports, copying and verification scans. Maximum RSS includes module loading. Existing file caches are not flushed. No model, invocation, retry or VACUUM is performed; this does not measure replay/recovery eligibility or production scale.' };
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`报告：${join(output, 'summary.json')}`);
}

function measure(path) {
  const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', path], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Migration measurement failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function assertClosed(path) {
  if (!(await stat(path)).isFile()) throw new Error('Source must be a regular file');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const exists = await stat(`${path}${suffix}`).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) throw new Error(`Close the experiment database before copying: ${suffix} exists`);
  }
}

function snapshot(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare('PRAGMA application_id').get().application_id !== 0x43415043) throw new Error('Not a conversation experiment database');
    const retention = database.prepare('SELECT COUNT(*) AS imageIdentities, COUNT(body) AS retainedBodies, COUNT(*) - COUNT(body) AS discardedBodies, (SELECT COUNT(*) FROM checkpoint_heads) AS heads FROM checkpoint_images').get();
    const identitiesDigest = hashRows(database.prepare('SELECT id, context_id, revision FROM checkpoint_images ORDER BY id').iterate());
    const headsDigest = hashRows(database.prepare('SELECT h.*, i.body FROM checkpoint_heads h JOIN checkpoint_images i ON i.id = h.image_id ORDER BY h.context_id').iterate());
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('checkpoint_images', 'checkpoint_heads', 'archive_usage') ORDER BY name").all();
    const otherFacts = createHash('sha256');
    for (const { name } of tables) {
      otherFacts.update(JSON.stringify(name));
      const quoted = `"${name.replaceAll('"', '""')}"`;
      otherFacts.update(hashRows(database.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).iterate()));
    }
    const currentCheckpointBytes = database.prepare("SELECT COALESCE(SUM(json_extract(i.body, '$.jsonBytes')), 0) + COALESCE(SUM(json_extract(h.delivery, '$.jsonBytes')), 0) AS bytes FROM checkpoint_heads h JOIN checkpoint_images i ON i.id = h.image_id").get().bytes;
    return { version: database.prepare('PRAGMA user_version').get().user_version, retention, identitiesDigest, headsDigest, otherFactsDigest: otherFacts.digest('hex'), currentCheckpointBytes, usage: database.prepare('SELECT * FROM archive_usage').get() };
  } finally {
    database.close();
  }
}

function hashRows(rows) {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
