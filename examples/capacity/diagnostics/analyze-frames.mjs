import { DatabaseSync } from 'node:sqlite';
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_MAX_BYTES, cloneCheckpointDelivery } from '@weiliang0121/capix-checkpoint';
import { decodeCheckpointRecord, isCheckpointRecord, materializeCheckpointHead, decodeCheckpointData, isCheckpointSelectionSlots, checkpointSelectionReferences } from '@weiliang0121/capix-checkpoint/storage';

const maxStoredBytes = Math.ceil((CHECKPOINT_MAX_BYTES + 1024) / 3) * 4 + 1024;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

/** Only analyze a closed capacity experiment database; never use this on a live host. */
export function analyzeFrames(databasePath) {
  const path = resolve(databasePath);
  if (!statSync(path).isFile()) throw new Error('Expected an existing experiment database file');
  try {
    if (statSync(`${path}-wal`).size !== 0) throw new Error('A nonempty WAL remains; close the experiment host before analyzing frames');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const uri = pathToFileURL(path);
  uri.searchParams.set('immutable', '1');
  const database = new DatabaseSync(uri.href, { readOnly: true, timeout: 0 });
  try {
    const storageFormat = database.prepare('PRAGMA user_version').get().user_version;
    if (database.prepare('PRAGMA application_id').get().application_id !== 0x43415043 || storageFormat !== 8) throw new Error('Expected a conversation experiment database in storage format 8');
    const totals = counter();
    const groups = new Map();
    const latest = new Map();
    let imageIdentities = 0;
    let discardedBodies = 0;
    for (const row of database.prepare('SELECT id, context_id, revision, body FROM checkpoint_images ORDER BY rowid').iterate()) {
      if (typeof row.id !== 'string' || !row.id.length || typeof row.context_id !== 'string' || !row.context_id.length || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid checkpoint image identity or revision');
      const previous = latest.get(row.context_id);
      if (previous && row.revision <= previous.revision) throw new Error('Checkpoint image revisions are not ordered');
      latest.set(row.context_id, { id: row.id, revision: row.revision, retained: row.body !== null });
      imageIdentities++;
      if (row.body === null) {
        discardedBodies++;
        continue;
      }
      if (!isCheckpointRecord(row.body)) throw new Error('Expected current incremental checkpoint storage');
      const image = materialize(database, row);
      const logicalBytes = bytes(image);
      if (image.id !== row.id || image.frame.owner.contextId !== row.context_id) throw new Error('Checkpoint image identity differs from its row');
      const key = JSON.stringify([image.contract.key, image.contract.version]);
      let group = groups.get(key);
      if (!group) {
        group = { contract: image.contract, counts: counter(), contexts: new Set(), points: new Map() };
        groups.set(key, group);
      }
      group.contexts.add(row.context_id);
      group.points.set(image.point, (group.points.get(image.point) ?? 0) + 1);
      add(totals, image, logicalBytes);
      add(group.counts, image, logicalBytes);
    }
    let heads = 0;
    let deliveries = 0;
    for (const row of database.prepare('SELECT context_id, revision, image_id, delivery FROM checkpoint_heads').iterate()) {
      const image = latest.get(row.context_id);
      const delivered = row.delivery !== null;
      if (!image || row.image_id !== image.id || row.revision !== image.revision + Number(delivered)) throw new Error('Checkpoint head differs from its latest image');
      if (!image.retained) throw new Error('Current checkpoint head body is missing');
      if (delivered) {
        const decoded = decode(row.delivery).value;
        cloneCheckpointDelivery(decodeCheckpointData(JSON.stringify(decoded)));
        deliveries++;
      }
      heads++;
    }
    if (heads !== latest.size) throw new Error('Checkpoint images have no owning head');
    if (totals.retainedBodies !== heads) throw new Error('Superseded checkpoint bodies remain in head-only storage');
    return {
      formatVersion: 2,
      storageFormat,
      scope: 'read-only closed experiment database; no body text or invocation identities',
      accounting: 'JSON bytes and field counts describe retained logical images reconstructed from v6 fact blocks when needed, not cumulative bytes written, physical stored bytes or capture/encode/compress cost. Discarded bodies cannot be reconstructed from identity rows. Repeated logical value bytes are not duplicated physical block bytes.',
      totals: { imageIdentities, discardedBodies, ...totals, heads, deliveries },
      contracts: [...groups.values()].map((group) => ({ contract: group.contract, ...group.counts, contexts: group.contexts.size, points: Object.fromEntries(group.points) })),
    };
  } finally {
    database.close();
  }
}

function materialize(database, row) {
  const head = decodeCheckpointRecord('head', row.body);
  if (head.commit.id !== row.id || head.commit.frame.owner.contextId !== row.context_id || head.revision !== row.revision) throw new Error('Checkpoint metadata differs from its row');
  const children = database
    .prepare('SELECT child_id,ordinal,body FROM checkpoint_relations WHERE context_id=? ORDER BY ordinal')
    .all(row.context_id)
    .map((item) => {
      const child = decodeCheckpointRecord('child', item.body);
      if (child.child.identity.contextId !== item.child_id || child.child.order !== item.ordinal) throw new Error('Checkpoint relation row differs');
      return child;
    });
  const values = database
    .prepare('SELECT id,metadata,body FROM checkpoint_values WHERE context_id=? AND body IS NOT NULL')
    .all(row.context_id)
    .map((item) => {
      const stored = decodeCheckpointRecord('value', item.metadata);
      if (stored.id !== item.id) throw new Error('Checkpoint value row differs');
      return { stored, body: JSON.stringify(decode(item.body).value) };
    });
  const selections = isCheckpointSelectionSlots(head.commit.references)
    ? checkpointSelectionReferences(head.commit.references).map(({ id }) => {
        const item = database.prepare('SELECT body FROM checkpoint_selections WHERE context_id=? AND id=?').get(row.context_id, id);
        if (!item || typeof item.body !== 'string') throw new Error('Missing checkpoint selection');
        const selection = decodeCheckpointRecord('selection', item.body);
        if (selection.owner !== row.context_id || selection.id !== id) throw new Error('Checkpoint selection row differs');
        const occurrences = database
          .prepare('SELECT occurrence_id,ordinal,body FROM checkpoint_occurrences WHERE context_id=? AND selection_id=? ORDER BY ordinal')
          .all(row.context_id, id)
          .map((entry) => {
            if (typeof entry.occurrence_id !== 'string' || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0) throw new Error('Invalid checkpoint occurrence row');
            if (entry.body === null) return { id: entry.occurrence_id, order: entry.ordinal };
            const occurrence = decodeCheckpointRecord('occurrence', entry.body);
            if (occurrence.id !== entry.occurrence_id || occurrence.order !== entry.ordinal || !occurrence.reference) throw new Error('Checkpoint occurrence row differs');
            return occurrence;
          });
        return { head: selection, occurrences };
      })
    : [];
  return materializeCheckpointHead(head, children, values, selections).image;
}

function counter() {
  return { retainedBodies: 0, jsonBytes: 0, frameBytes: 0, stateBytes: 0, inputBytes: 0, currentInputBytes: 0, childrenBytes: 0, childInputBytes: 0, sameInputCount: 0, sameInputBytes: 0, sameChildCurrentCount: 0, sameChildCurrentBytes: 0, sameReceptionCount: 0, sameReceptionBytes: 0 };
}

function add(counts, image, jsonBytes) {
  counts.retainedBodies++;
  counts.jsonBytes += jsonBytes;
  counts.frameBytes += bytes(image.frame);
  counts.stateBytes += bytes(image.state);
  counts.inputBytes += bytes(image.frame.input);
  counts.currentInputBytes += bytes(image.frame.currentInput);
  counts.childrenBytes += bytes(image.frame.children);
  if (isDeepStrictEqual(image.frame.input, image.frame.currentInput)) {
    counts.sameInputCount++;
    counts.sameInputBytes += bytes(image.frame.currentInput);
  }
  for (const child of image.frame.children) {
    counts.childInputBytes += bytes(child.input);
    if (child.state.progress && isDeepStrictEqual(child.input, child.state.progress.currentInput)) {
      counts.sameChildCurrentCount++;
      counts.sameChildCurrentBytes += bytes(child.state.progress.currentInput);
    }
    const reception = child.state.reception;
    if (child.state.kind === 'returned' && reception.kind === 'accepted' && Object.hasOwn(reception, 'output') && isDeepStrictEqual(child.state.output, reception.output)) {
      counts.sameReceptionCount++;
      counts.sameReceptionBytes += bytes(reception.output);
    }
  }
}

function decode(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > maxStoredBytes) throw new Error('Checkpoint storage exceeds its byte limit');
  const payload = parse(body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 3 || payload.encoding !== 'br' || !Number.isSafeInteger(payload.jsonBytes) || payload.jsonBytes <= 0 || payload.jsonBytes > CHECKPOINT_MAX_BYTES || typeof payload.data !== 'string' || !payload.data.length || payload.data.length % 4 !== 0) throw new Error('Invalid checkpoint storage envelope');
  const compressed = Buffer.from(payload.data, 'base64');
  if (compressed.byteLength > CHECKPOINT_MAX_BYTES + 1024 || compressed.toString('base64') !== payload.data) throw new Error('Invalid checkpoint base64 data');
  let json;
  try {
    json = brotliDecompressSync(compressed, { maxOutputLength: payload.jsonBytes });
  } catch {
    throw new Error('Checkpoint decompression failed or exceeded its declared limit');
  }
  if (json.byteLength !== payload.jsonBytes) throw new Error('Checkpoint decompressed length differs from its metadata');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(json);
  } catch {
    throw new Error('Checkpoint payload is not valid UTF-8');
  }
  return { value: parse(text), jsonBytes: payload.jsonBytes };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Native JSON errors can include a body excerpt. Diagnostics contain no text.
    throw new Error('Checkpoint payload is not valid JSON');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node analyze-frames.mjs CLOSED_EXPERIMENT_DB NEW_OUTPUT_FILE');
  const report = analyzeFrames(process.argv[2]);
  writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Analyzed ${report.totals.imageIdentities} image identities, ${report.totals.retainedBodies} retained bodies, ${report.totals.discardedBodies} discarded bodies and ${report.totals.heads} heads; wrote metadata-only report`);
}
