import { DatabaseSync } from 'node:sqlite';
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_MAX_BYTES, cloneCheckpointImage, cloneCheckpointDelivery } from '@capix/checkpoint';

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
    if (database.prepare('PRAGMA application_id').get().application_id !== 0x43415043 || database.prepare('PRAGMA user_version').get().user_version !== 3) throw new Error('Expected a conversation experiment database in storage format 3');
    const totals = counter();
    const groups = new Map();
    const latest = new Map();
    for (const row of database.prepare('SELECT id, context_id, revision, body FROM checkpoint_images ORDER BY rowid').iterate()) {
      const decoded = decode(row.body);
      const image = cloneCheckpointImage(decoded.value);
      if (image.id !== row.id || image.frame.owner.contextId !== row.context_id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Checkpoint image identity or revision differs from its row');
      const previous = latest.get(row.context_id);
      if (previous && row.revision <= previous.revision) throw new Error('Checkpoint image revisions are not ordered');
      latest.set(row.context_id, { id: row.id, revision: row.revision });
      const key = JSON.stringify([image.contract.key, image.contract.version]);
      let group = groups.get(key);
      if (!group) {
        group = { contract: image.contract, counts: counter(), contexts: new Set(), points: new Map() };
        groups.set(key, group);
      }
      group.contexts.add(row.context_id);
      group.points.set(image.point, (group.points.get(image.point) ?? 0) + 1);
      add(totals, image, decoded.jsonBytes);
      add(group.counts, image, decoded.jsonBytes);
    }
    let heads = 0;
    let deliveries = 0;
    for (const row of database.prepare('SELECT context_id, revision, image_id, delivery FROM checkpoint_heads').iterate()) {
      const image = latest.get(row.context_id);
      const delivered = row.delivery !== null;
      if (!image || row.image_id !== image.id || row.revision !== image.revision + Number(delivered)) throw new Error('Checkpoint head differs from its latest image');
      if (delivered) {
        cloneCheckpointDelivery(decode(row.delivery).value);
        deliveries++;
      }
      heads++;
    }
    if (heads !== latest.size) throw new Error('Checkpoint images have no owning head');
    return {
      formatVersion: 1,
      scope: 'read-only closed experiment database; no body text or invocation identities',
      accounting: 'JSON bytes for images and individual fields; repeated value bytes are not a promised storage saving. A value may be stored at several different semantic boundaries.',
      totals: { ...totals, heads, deliveries },
      contracts: [...groups.values()].map((group) => ({ contract: group.contract, ...group.counts, contexts: group.contexts.size, points: Object.fromEntries(group.points) })),
    };
  } finally {
    database.close();
  }
}

function counter() {
  return { images: 0, jsonBytes: 0, frameBytes: 0, stateBytes: 0, inputBytes: 0, currentInputBytes: 0, childrenBytes: 0, childInputBytes: 0, sameInputCount: 0, sameInputBytes: 0, sameChildCurrentCount: 0, sameChildCurrentBytes: 0, sameReceptionCount: 0, sameReceptionBytes: 0 };
}

function add(counts, image, jsonBytes) {
  counts.images++;
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
  console.log(`Analyzed ${report.totals.images} images and ${report.totals.heads} heads; wrote metadata-only report`);
}
