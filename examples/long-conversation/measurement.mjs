import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CHECKPOINT_MAX_BYTES } from '@weiliang0121/capix-checkpoint';
import { decodeCheckpointRecord, isCheckpointRecord } from '@weiliang0121/capix-checkpoint/storage';

/** UTF-8 bytes of the text itself, without JSON quotes or escaping. */
export function textBytes(text) {
  if (typeof text !== 'string') throw new TypeError('textBytes requires a string');
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-8 bytes of JSON.stringify(value), including quotes and escaping for strings. */
export function jsonBytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value has no JSON representation');
  return textBytes(serialized);
}

/** Usage comes from accepted ModelReply values. Cache totals cover only complete hit/miss reports. */
export function measureUsage(requests) {
  const reported = requests.flatMap((request) => (request.usage ? [request.usage] : []));
  const cached = reported.filter((usage) => usage.promptCacheHitTokens !== undefined && usage.promptCacheMissTokens !== undefined);
  const sum = (values, key) => (values.length ? values.reduce((total, value) => total + value[key], 0) : null);
  return {
    usageReportedRequests: reported.length,
    promptTokens: sum(reported, 'promptTokens'),
    completionTokens: sum(reported, 'completionTokens'),
    cacheReportedRequests: cached.length,
    cachePromptTokens: sum(cached, 'promptTokens'),
    promptCacheHitTokens: sum(cached, 'promptCacheHitTokens'),
    promptCacheMissTokens: sum(cached, 'promptCacheMissTokens'),
  };
}

/** File lengths at the time of each stat; safe while the host is running, but not an atomic snapshot. */
export function measureFiles(path) {
  const dbBytes = statSync(path).size;
  const walBytes = optionalFileBytes(`${path}-wal`);
  const shmBytes = optionalFileBytes(`${path}-shm`);
  return { dbBytes, walBytes, shmBytes, totalBytes: dbBytes + walBytes + shmBytes };
}

/**
 * Measure a closed conversation v2/v3/v4/v5/v6/v7/v8 database. The caller must stop the host and keep it closed.
 * Ordinary SQLite read-only connections can create WAL/SHM files; immutable mode avoids that,
 * but ignores WAL, so reject any nonempty WAL instead of reporting incomplete SQL contents.
 * CP `bytes`/`maxBytes` retain the original JSON size; v3 obtains it from validated storage
 * metadata, without decompressing or certifying the payload. `storedBytes` measures the actual
 * envelope text, including base64. Both measure retained bodies, not cumulative saves;
 * v6 keeps historical identity rows after discarding their body. Other body sizes remain UTF-8 JSON text.
 * `logicalBytes` includes free pages; file lengths are separate and are not cumulative writes.
 */
export function measureDatabase(path) {
  const files = measureFiles(path);
  if (files.walBytes !== 0) throw new Error('Close the conversation host before measuring SQL contents: a nonempty WAL remains');
  const uri = pathToFileURL(resolve(path));
  uri.searchParams.set('immutable', '1');
  const database = new DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
  try {
    const applicationId = database.prepare('PRAGMA application_id').get().application_id;
    const schemaVersion = database.prepare('PRAGMA user_version').get().user_version;
    if (applicationId !== 0x43415043 || ![2, 3, 4, 5, 6, 7, 8].includes(schemaVersion)) throw new Error('Measurement requires a conversation schema v2/v3/v4/v5/v6/v7/v8 database');
    if (schemaVersion >= 6 && database.prepare('SELECT 1 FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id WHERE i.id IS NULL OR i.body IS NULL LIMIT 1').get()) throw new Error('Current checkpoint head body is missing');
    const images = measureCheckpoints(database, schemaVersion, 'checkpoint_images', 'body');
    const deliveries = measureCheckpoints(database, schemaVersion, 'checkpoint_heads', 'delivery');
    const heads = { count: deliveries.count, deliveryBytes: deliveries.bytes, maxDeliveryBytes: deliveries.maxBytes, storedDeliveryBytes: deliveries.storedBytes, maxStoredDeliveryBytes: deliveries.maxStoredBytes };
    const facts =
      schemaVersion >= 7
        ? {
            values: measureCheckpoints(database, schemaVersion, 'checkpoint_values', 'body'),
            metadataBytes: database.prepare('SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) AS bytes FROM checkpoint_values').get().bytes,
            relations: measureBodies(database, 'checkpoint_relations'),
            ...(schemaVersion >= 8 ? { selections: measureBodies(database, 'checkpoint_selections'), occurrences: measureBodies(database, 'checkpoint_occurrences') } : {}),
          }
        : undefined;
    const completionInteractions = measureBodies(database, 'completion_interactions');
    const modelExchanges = schemaVersion >= 4 ? { collections: database.prepare('SELECT COUNT(*) AS count FROM model_exchanges').get().count, entries: measureBodies(database, 'model_exchange_entries'), metadataBytes: schemaVersion >= 5 ? database.prepare('SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))), 0) AS bytes FROM model_exchanges').get().bytes : 0 } : undefined;
    // Recompute the host's retained JSON categories; do not trust its accounting
    // table as independent experimental evidence or confuse this with file size.
    const archiveJsonBytes = (facts ? facts.values.bytes + facts.metadataBytes + facts.relations.bytes + (facts.selections?.bytes ?? 0) + (facts.occurrences?.bytes ?? 0) : 0) + images.bytes + heads.deliveryBytes + completionInteractions.bytes + (modelExchanges?.entries.bytes ?? 0) + (modelExchanges?.metadataBytes ?? 0);
    const messages = measureBodies(database, 'messages');
    const memories = measureBodies(database, 'memories');
    const appendReceipts = measureBodies(database, 'append_receipts');
    const applyReceipts = measureBodies(database, 'apply_receipts');
    const content = { ...database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(starts AS BLOB))), 0) AS startsBytes, COALESCE(SUM(length(CAST(view_state AS BLOB))), 0) AS viewStateBytes FROM content').get() };
    const pageCount = database.prepare('PRAGMA page_count').get().page_count;
    const freelistCount = database.prepare('PRAGMA freelist_count').get().freelist_count;
    const pageSize = database.prepare('PRAGMA page_size').get().page_size;
    return { schemaVersion, checkpoints: { originalBytesSource: schemaVersion >= 3 ? 'storage-metadata' : 'body-text', images, heads, ...(facts ? { facts } : {}) }, completionInteractions, ...(modelExchanges ? { modelExchanges } : {}), archiveJsonBytes, messages, memories, appendReceipts, applyReceipts, content, sqlite: { pageCount, freelistCount, pageSize, logicalBytes: pageCount * pageSize }, files };
  } finally {
    database.close();
  }
}

function measureBodies(database, table) {
  // Table names are fixed by this module, never supplied by the caller.
  return { ...database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes, COALESCE(MAX(length(CAST(body AS BLOB))), 0) AS maxBytes FROM ${table}`).get() };
}

function measureCheckpoints(database, version, table, column) {
  const totals = { count: 0, bytes: 0, maxBytes: 0, storedBytes: 0, maxStoredBytes: 0 };
  let retainedBodies = 0;
  let discardedBodies = 0;
  // Names are fixed by the two calls above. Count heads without a terminal delivery as well.
  for (const row of database.prepare(`SELECT ${column} AS body FROM ${table}`).iterate()) {
    totals.count++;
    if (row.body === null) {
      if (column === 'delivery') continue;
      if (version < 6) throw new Error('Historical checkpoint body is missing in a format that retains all images');
      discardedBodies++;
      continue;
    }
    retainedBodies++;
    const storedBytes = textBytes(row.body);
    const bytes = version >= 3 ? originalCheckpointBytes(row.body, storedBytes) : storedBytes;
    totals.bytes += bytes;
    totals.maxBytes = Math.max(totals.maxBytes, bytes);
    totals.storedBytes += storedBytes;
    totals.maxStoredBytes = Math.max(totals.maxStoredBytes, storedBytes);
  }
  return column === 'body' ? { ...totals, retainedBodies, discardedBodies } : totals;
}

function originalCheckpointBytes(body, storedBytes) {
  const maxStoredBytes = Math.ceil((CHECKPOINT_MAX_BYTES + 1024) / 3) * 4 + 1024;
  if (storedBytes > maxStoredBytes) throw new Error('Checkpoint storage metadata exceeds its byte limit');
  if (isCheckpointRecord(body)) {
    decodeCheckpointRecord('head', body);
    return storedBytes;
  }
  const payload = JSON.parse(body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'data,encoding,jsonBytes' || payload.encoding !== 'br' || !Number.isSafeInteger(payload.jsonBytes) || payload.jsonBytes <= 0 || payload.jsonBytes > CHECKPOINT_MAX_BYTES || typeof payload.data !== 'string' || !payload.data.length || payload.data.length % 4 !== 0) throw new Error('Invalid checkpoint storage metadata');
  const compressed = Buffer.from(payload.data, 'base64');
  if (compressed.byteLength > CHECKPOINT_MAX_BYTES + 1024 || compressed.toString('base64') !== payload.data) throw new Error('Invalid checkpoint storage data');
  return payload.jsonBytes;
}

function optionalFileBytes(path) {
  try {
    return statSync(path).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
