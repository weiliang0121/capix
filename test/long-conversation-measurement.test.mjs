import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync } from 'node:zlib';
import test from 'node:test';
import { jsonBytes, measureDatabase, measureFiles, measureUsage, textBytes } from '../examples/long-conversation/measurement.mjs';
import { renderReport } from '../examples/long-conversation/report.mjs';

for (const version of [2, 3, 4, 5, 6])
  test(`long-conversation v${version} measurements distinguish original JSON, stored payload and WAL without modifying the database`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-long-conversation-measurement-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'conversation 空格.sqlite');
    const writer = new DatabaseSync(path);
    t.after(() => writer.isOpen && writer.close());
    // Artificial tables isolate the measurement contract without importing private service code.
    writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA application_id = 1128353859;
    PRAGMA user_version = ${version};
    CREATE TABLE content (singleton INTEGER PRIMARY KEY, starts TEXT NOT NULL, view_state TEXT NOT NULL);
    CREATE TABLE messages (position INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE memories (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE append_receipts (ordinal INTEGER PRIMARY KEY, operation TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE apply_receipts (ordinal INTEGER PRIMARY KEY, operation TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE checkpoint_images (id TEXT PRIMARY KEY, context_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT ${version >= 6 ? '' : 'NOT NULL'});
    CREATE TABLE checkpoint_heads (context_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, image_id TEXT NOT NULL, delivery TEXT);
    CREATE TABLE completion_interactions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
  `);
    const exchange = { reply: { text: '工具回复🙂' }, feedback: [{ content: '工具结果' }] };
    const exchangeMetadata = { scope: '测量', source: { transcriptId: 'transcript', index: 0 } };
    if (version >= 4) {
      writer.exec('CREATE TABLE model_exchanges (id TEXT PRIMARY KEY, metadata TEXT); CREATE TABLE model_exchange_entries (id TEXT PRIMARY KEY, body TEXT NOT NULL);');
      writer.prepare('INSERT INTO model_exchanges VALUES (?, ?)').run('collection', version >= 5 ? JSON.stringify(exchangeMetadata) : null);
      writer.prepare('INSERT INTO model_exchange_entries VALUES (?, ?)').run('exchange', JSON.stringify(exchange));
    }
    const stored = (value) => (version === 2 ? JSON.stringify(value) : JSON.stringify({ encoding: 'br', jsonBytes: jsonBytes(value), data: brotliCompressSync(JSON.stringify(value)).toString('base64') }));
    const images = [{ text: '甲' }, { text: '重复材料🙂'.repeat(1000) }, { text: '末次' }];
    for (const [index, image] of images.entries()) writer.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run(`image-${index}`, 'context-1', index + 1, version >= 6 && index < 2 ? null : stored(image));
    const waitingImage = { text: '在途' };
    writer.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run('image-unused', 'context-2', 1, stored(waitingImage));
    const retained = version >= 6 ? [images[2], waitingImage] : [...images, waitingImage];
    const delivery = { kind: 'succeeded', value: '回答🙂' };
    writer.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, ?)').run('context-1', 4, 'image-2', stored(delivery));
    writer.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, ?)').run('context-2', 1, 'image-unused', null);
    const interaction = { request: { text: '请求' }, reply: { text: '结果🙂' } };
    writer.prepare('INSERT INTO completion_interactions VALUES (?, ?, ?)').run('interaction-1', 1, JSON.stringify(interaction));
    const message = { role: 'user', content: '你好\n"quoted"🙂' };
    const memory = { content: '记忆', sourceIndexes: [0] };
    const appendReceipt = { key: '追加', index: 0 };
    const applyReceipt = { key: '应用', ids: ['memory-1'] };
    writer.prepare('INSERT INTO messages VALUES (?, ?)').run(0, JSON.stringify(message));
    writer.prepare('INSERT INTO memories VALUES (?, ?, ?)').run(0, 'memory-1', JSON.stringify(memory));
    writer.prepare('INSERT INTO append_receipts VALUES (?, ?, ?)').run(0, 'append-1', JSON.stringify(appendReceipt));
    writer.prepare('INSERT INTO apply_receipts VALUES (?, ?, ?)').run(0, 'apply-1', JSON.stringify(applyReceipt));
    const view = { members: [{ source: 'messages', key: 0 }] };
    writer.prepare('INSERT INTO content VALUES (?, ?, ?)').run(1, '[0]', JSON.stringify(view));

    assert.equal(textBytes('中文🙂'), 10);
    assert.equal(jsonBytes('中文🙂'), 12);
    assert.equal(jsonBytes('\n'), 4);
    assert.throws(() => textBytes(12), TypeError);
    assert.throws(() => jsonBytes(undefined), TypeError);
    const runningFiles = measureFiles(path);
    assert.ok(runningFiles.walBytes > 0);
    assert.ok(runningFiles.shmBytes > 0);
    assert.equal(runningFiles.totalBytes, runningFiles.dbBytes + runningFiles.walBytes + runningFiles.shmBytes);
    assert.throws(() => measureDatabase(path), /nonempty WAL/);
    assert.deepEqual(measureFiles(path), runningFiles);
    writer.close();

    const beforeNames = readdirSync(directory).sort();
    const beforeContents = readFileSync(path);
    const beforeStat = statSync(path);
    const measured = measureDatabase(path);
    assert.equal(measured.schemaVersion, version);
    assert.equal(measured.checkpoints.originalBytesSource, version >= 3 ? 'storage-metadata' : 'body-text');
    assert.deepEqual(measured.checkpoints.images, { count: 4, retainedBodies: retained.length, discardedBodies: 4 - retained.length, bytes: retained.reduce((total, value) => total + jsonBytes(value), 0), maxBytes: Math.max(...retained.map(jsonBytes)), storedBytes: retained.reduce((total, value) => total + textBytes(stored(value)), 0), maxStoredBytes: Math.max(...retained.map((value) => textBytes(stored(value)))) });
    assert.ok(measured.checkpoints.images.bytes > measured.checkpoints.images.maxBytes);
    if (version >= 3 && version < 6) assert.ok(measured.checkpoints.images.storedBytes < measured.checkpoints.images.bytes / 10);
    assert.deepEqual(measured.checkpoints.heads, { count: 2, deliveryBytes: jsonBytes(delivery), maxDeliveryBytes: jsonBytes(delivery), storedDeliveryBytes: textBytes(stored(delivery)), maxStoredDeliveryBytes: textBytes(stored(delivery)) });
    for (const [name, body] of Object.entries({ completionInteractions: interaction, messages: message, memories: memory, appendReceipts: appendReceipt, applyReceipts: applyReceipt })) assert.deepEqual(measured[name], { count: 1, bytes: jsonBytes(body), maxBytes: jsonBytes(body) });
    if (version >= 4) assert.deepEqual(measured.modelExchanges, { collections: 1, entries: { count: 1, bytes: jsonBytes(exchange), maxBytes: jsonBytes(exchange) }, metadataBytes: version >= 5 ? jsonBytes(exchangeMetadata) : 0 });
    else assert.equal(measured.modelExchanges, undefined);
    assert.equal(measured.archiveJsonBytes, retained.reduce((sum, image) => sum + jsonBytes(image), 0) + jsonBytes(delivery) + jsonBytes(interaction) + (version >= 4 ? jsonBytes(exchange) : 0) + (version >= 5 ? jsonBytes(exchangeMetadata) : 0));
    assert.deepEqual(measured.content, { count: 1, startsBytes: textBytes('[0]'), viewStateBytes: jsonBytes(view) });
    assert.equal(measured.sqlite.logicalBytes, measured.sqlite.pageCount * measured.sqlite.pageSize);
    assert.ok(measured.sqlite.freelistCount >= 0);
    assert.equal(measured.files.dbBytes, measured.sqlite.logicalBytes);
    assert.ok(measured.sqlite.logicalBytes > measured.checkpoints.images.bytes);
    assert.equal(measured.files.walBytes, 0);
    assert.equal(measured.files.shmBytes, 0);
    assert.deepEqual(measured.files, measureFiles(path));
    assert.deepEqual(readFileSync(path), beforeContents);
    assert.deepEqual(readdirSync(directory).sort(), beforeNames);
    assert.equal(statSync(path).mtimeMs, beforeStat.mtimeMs);
    assert.equal(statSync(path).ctimeMs, beforeStat.ctimeMs);

    if (version >= 6) {
      const corruptor = new DatabaseSync(path);
      corruptor.exec("UPDATE checkpoint_images SET body = NULL WHERE id = 'image-2'");
      corruptor.close();
      assert.throws(() => measureDatabase(path), /Current checkpoint head body is missing/);
      const reset = new DatabaseSync(path);
      reset.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(images[2]), 'image-2');
      reset.close();
    }

    if (version >= 3) {
      const valid = JSON.parse(stored(images[0]));
      const invalid = [
        { ...valid, encoding: 'gzip' },
        { ...valid, jsonBytes: 0 },
        { ...valid, jsonBytes: 8 * 1024 * 1024 + 1 },
        { ...valid, jsonBytes: 1.5 },
        { ...valid, extra: 'field' },
        { ...valid, data: '!!!!' },
      ];
      for (const value of invalid) {
        const corruptor = new DatabaseSync(path);
        corruptor.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify(value), 'image-0');
        corruptor.close();
        const bytes = readFileSync(path);
        assert.throws(() => measureDatabase(path), /checkpoint storage/);
        assert.deepEqual(readFileSync(path), bytes);
      }
      const reset = new DatabaseSync(path);
      reset.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(version >= 6 ? null : stored(images[0]), 'image-0');
      reset.close();
    }
    const modifier = new DatabaseSync(path);
    modifier.exec('DROP TABLE completion_interactions');
    modifier.close();
    assert.throws(() => measureDatabase(path), /no such table: completion_interactions/);
    const wrongVersion = new DatabaseSync(path);
    wrongVersion.exec('PRAGMA user_version = 1');
    wrongVersion.close();
    assert.throws(() => measureDatabase(path), /schema v2\/v3/);
    assert.throws(() => measureDatabase(join(directory, 'missing.sqlite')), { code: 'ENOENT' });
  });

test('cache totals report coverage separately from all prompt tokens and preserve unknown counts', () => {
  const usage = (extra = {}) => ({ promptTokens: 100, completionTokens: 10, totalTokens: 110, ...extra });
  const measured = measureUsage([{ usage: usage({ promptCacheHitTokens: 80, promptCacheMissTokens: 20 }) }, { usage: usage({ promptCacheHitTokens: 0, promptCacheMissTokens: 100 }) }, { usage: usage({ promptCacheHitTokens: 50 }) }, { usage: usage() }, { usage: null }]);
  assert.deepEqual(measured, { usageReportedRequests: 4, promptTokens: 400, completionTokens: 40, cacheReportedRequests: 2, cachePromptTokens: 200, promptCacheHitTokens: 80, promptCacheMissTokens: 120 });
  const missing = measureUsage([{ usage: usage() }, {}]);
  assert.equal(missing.cacheReportedRequests, 0);
  assert.equal(missing.promptCacheHitTokens, null);
  assert.equal(missing.promptCacheMissTokens, null);
  assert.equal(measureUsage([]).promptTokens, null);
});

test('long-conversation token reporting includes all attempts and makes missing usage explicit', () => {
  const summary = {
    mode: 'live',
    completed: 1,
    planned: 2,
    modelCalls: 3,
    complete: false,
    checkpoints: [],
    snapshots: [],
    reloads: [],
    phases: {
      answer: { requests: 2, usageReportedRequests: 2, jsonBytes: 100, promptTokens: 100, completionTokens: 20 },
      memory: { requests: 1, usageReportedRequests: 1, jsonBytes: 40, promptTokens: 10, completionTokens: 5 },
    },
    maintenance: { accepted: 0, handled: 1, 'not-observed': 1 },
  };
  const report = renderReport(summary, []);
  assert.match(report, /input 110 \+ output 25 = 135 tokens/);
  assert.match(report, /覆盖 3\/3 次请求/);
  assert.match(report, /记忆维护占 11\.11%/);
  assert.match(report, /失败、截断和维护被跳过的尝试仍计入消耗/);
  assert.match(report, /不能将全部 token 称为内核额外开销/);
  assert.match(report, /\| answer \| 0\/2 \| 未知 \| 未知 \| 未知 \|/);
  Object.assign(summary.phases.answer, { cacheReportedRequests: 1, cachePromptTokens: 50, promptCacheHitTokens: 40, promptCacheMissTokens: 10 });
  assert.match(renderReport(summary, []), /\| answer \| 1\/2 \| 40 \| 10 \| 80\.00% \|/);
  summary.phases.answer.usageReportedRequests = 1;
  assert.match(renderReport(summary, []), /覆盖 2\/3 次请求，未报告部分未知/);
  for (const phase of Object.values(summary.phases)) Object.assign(phase, { usageReportedRequests: 0, promptTokens: null, completionTokens: null });
  assert.match(renderReport(summary, []), /模型未提供 usage，不能从请求字节或调用次数推算 token 消耗/);
});
