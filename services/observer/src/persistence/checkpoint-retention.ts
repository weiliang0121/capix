import type { DatabaseSync } from 'node:sqlite';
import { isEqual } from 'es-toolkit';
import { CHECKPOINT_MAX_BYTES, cloneCheckpointValue, cloneCheckpointImage, cloneCheckpointDelivery } from '@capix/checkpoint';

type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Called inside the store's transaction. Identity rows survive body retirement.
 * This table-local migration does not change the Observer content format. Older
 * writers can still read heads and reject reused IDs; they may retain extra bodies.
 */
export function initializeCheckpointRetention(database: DatabaseSync): void {
  const images = database.prepare('PRAGMA table_xinfo(checkpoint_images)').all();
  const heads = database.prepare('PRAGMA table_xinfo(checkpoint_heads)').all();
  if (!images.length && !heads.length) {
    database.exec(tables('checkpoint_images', 'checkpoint_heads'));
    indexHeads(database);
    return;
  }
  const legacy = checkTables(database, images, heads);
  indexHeads(database);
  const obsolete = database.prepare('SELECT 1 FROM checkpoint_images i WHERE body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkpoint_heads h WHERE h.image_id = i.id) LIMIT 1').get();
  if (!legacy && !obsolete) return;

  // Before discarding anything, validate every retained body and the complete
  // revision/ownership chain. Iterate one body at a time, never load the archive.
  const retired = inspectArchive(database, legacy);
  if (legacy) {
    database.exec(tables('checkpoint_images_next', 'checkpoint_heads_next'));
    database.exec(`
      INSERT INTO checkpoint_images_next SELECT i.id, i.context_id, i.revision,
        CASE WHEN EXISTS (SELECT 1 FROM checkpoint_heads h WHERE h.image_id = i.id) THEN i.body ELSE NULL END
        FROM checkpoint_images i;
      INSERT INTO checkpoint_heads_next SELECT context_id, revision, image_id, delivery FROM checkpoint_heads;
      DROP TABLE checkpoint_heads;
      DROP TABLE checkpoint_images;
      ALTER TABLE checkpoint_images_next RENAME TO checkpoint_images;
      ALTER TABLE checkpoint_heads_next RENAME TO checkpoint_heads;
    `);
    indexHeads(database);
  } else {
    const result = database.prepare('UPDATE checkpoint_images SET body = NULL WHERE body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkpoint_heads h WHERE h.image_id = checkpoint_images.id)').run();
    if (result.changes !== retired) throw new Error('Checkpoint retirement did not affect the exact obsolete bodies');
  }
}

function indexHeads(database: DatabaseSync): void {
  // Avoid scanning every invocation head for each retained identity row.
  // A same-named index is not proof that it indexes the expected table or column.
  const existing = database.prepare('SELECT type, tbl_name FROM sqlite_master WHERE name = ?').get('checkpoint_heads_image');
  if (!existing) {
    database.exec('CREATE INDEX checkpoint_heads_image ON checkpoint_heads(image_id)');
    return;
  }
  const index = database
    .prepare('PRAGMA index_list(checkpoint_heads)')
    .all()
    .find((row) => row.name === 'checkpoint_heads_image');
  if (existing.type !== 'index' || existing.tbl_name !== 'checkpoint_heads' || index?.unique !== 0 || index.origin !== 'c' || index.partial !== 0 || !indexColumns(database, 'checkpoint_heads_image', ['image_id'])) throw new Error('Unknown checkpoint head index');
}

function checkTables(database: DatabaseSync, images: Row[], heads: Row[]): boolean {
  const bodyRequired = images[3]?.notnull;
  if (
    (bodyRequired !== 0 && bodyRequired !== 1) ||
    !columns(images, [
      ['id', 'TEXT', 0, 1],
      ['context_id', 'TEXT', 1, 0],
      ['revision', 'INTEGER', 1, 0],
      ['body', 'TEXT', bodyRequired, 0],
    ]) ||
    !columns(heads, [
      ['context_id', 'TEXT', 0, 1],
      ['revision', 'INTEGER', 1, 0],
      ['image_id', 'TEXT', 1, 0],
      ['delivery', 'TEXT', 0, 0],
    ])
  )
    throw new Error('Unknown checkpoint storage columns');
  const imageKeys = database.prepare('PRAGMA foreign_key_list(checkpoint_images)').all();
  const headKeys = database.prepare('PRAGMA foreign_key_list(checkpoint_heads)').all();
  const key = headKeys[0];
  if (imageKeys.length !== 0 || headKeys.length !== 1 || key?.seq !== 0 || key.table !== 'checkpoint_images' || key.from !== 'image_id' || key.to !== 'id' || key.on_update !== 'NO ACTION' || key.on_delete !== 'NO ACTION' || key.match !== 'NONE') throw new Error('Unknown checkpoint storage foreign keys');
  const revisions = database
    .prepare('PRAGMA index_list(checkpoint_images)')
    .all()
    .some((index) => index.unique === 1 && index.origin === 'u' && index.partial === 0 && typeof index.name === 'string' && indexColumns(database, index.name, ['context_id', 'revision']));
  if (!revisions) throw new Error('Checkpoint storage has no unique revision constraint');
  return bodyRequired === 1;
}

function columns(rows: Row[], expected: readonly (readonly [string, string, number, number])[]): boolean {
  return (
    rows.length === expected.length &&
    rows.every((row, i) => {
      const column = expected[i]!;
      return row.cid === i && row.name === column[0] && row.type === column[1] && row.notnull === column[2] && row.pk === column[3] && row.dflt_value === null && row.hidden === 0;
    })
  );
}

function indexColumns(database: DatabaseSync, name: string, expected: readonly string[]): boolean {
  const columns = database.prepare('SELECT * FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno').all(name);
  return columns.length === expected.length && columns.every((column, i) => column.name === expected[i] && column.desc === 0 && column.coll === 'BINARY');
}

function tables(images: string, heads: string): string {
  return `CREATE TABLE ${images} (
    id TEXT PRIMARY KEY, context_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), body TEXT,
    UNIQUE (context_id, revision)
  );
  CREATE TABLE ${heads} (
    context_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
    image_id TEXT NOT NULL REFERENCES ${images}(id), delivery TEXT
  );`;
}

function inspectArchive(database: DatabaseSync, legacy: boolean): number {
  if (database.prepare('SELECT 1 FROM checkpoint_heads h LEFT JOIN checkpoint_images i ON i.id = h.image_id WHERE i.id IS NULL OR i.context_id != h.context_id LIMIT 1').get()) throw new Error('Checkpoint head has no matching image');
  let context: string | undefined;
  let revision = 0;
  let baseline: { owner: unknown; contract: unknown; input: unknown } | undefined;
  let retired = 0;
  const rows = database.prepare(`SELECT i.*, h.revision AS head_revision, h.image_id, h.delivery
    FROM checkpoint_images i LEFT JOIN checkpoint_heads h ON h.context_id = i.context_id
    ORDER BY i.context_id, i.revision DESC`);
  for (const row of rows.iterate()) {
    if (!identity(row.id) || !identity(row.context_id) || !positive(row.revision) || !positive(row.head_revision) || !identity(row.image_id)) throw new Error('Invalid checkpoint archive identity or ownership');
    const first = row.context_id !== context;
    if (first) {
      if (context !== undefined && revision !== 1) throw new Error('Checkpoint archive has a revision gap');
      context = row.context_id;
      if (row.id !== row.image_id || row.head_revision !== row.revision + (row.delivery === null ? 0 : 1)) throw new Error('Checkpoint head differs from its latest image');
      baseline = undefined;
    } else if (row.revision !== revision - 1) throw new Error('Checkpoint archive has a revision gap');
    revision = row.revision;
    if (row.body === null) {
      if (legacy || first) throw new Error('Current checkpoint image has no body');
      continue;
    }
    const image = inspectImage(row);
    const fixed = { owner: image.frame.owner, contract: image.contract, input: image.frame.input };
    if (!baseline) baseline = fixed;
    else if (!isEqual(baseline, fixed)) throw new Error('Checkpoint archive changed its owner, contract or original input');
    if (first && row.delivery !== null) {
      const delivery = parse(row.delivery);
      if (!object(delivery) || !['succeeded', 'failed', 'cancelled'].includes(String(delivery.status)) || (delivery.status === 'succeeded' && !Object.hasOwn(delivery, 'output'))) throw new Error('Invalid historical checkpoint delivery');
      if (image.formatVersion === 5) cloneCheckpointDelivery(delivery);
    }
    if (!first) retired++;
  }
  if (context !== undefined && revision !== 1) throw new Error('Checkpoint archive has a revision gap');
  return retired;
}

function inspectImage(row: Row) {
  const image = parse(row.body);
  if (!object(image) || image.id !== row.id || !positive(image.formatVersion) || !object(image.frame) || !object(image.frame.owner) || image.frame.owner.contextId !== row.context_id || !Object.hasOwn(image.frame, 'input') || !object(image.contract) || !identity(image.contract.key) || !positive(image.contract.version)) throw new Error('Stored checkpoint body differs from its identity');
  if (image.formatVersion === 5) cloneCheckpointImage(image);
  // Older images remain their original format. Only storage identity is certified;
  // ordinary read still refuses unsupported recovery formats.
  return { formatVersion: image.formatVersion, frame: { owner: image.frame.owner, input: image.frame.input }, contract: image.contract };
}

function parse(value: unknown) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CHECKPOINT_MAX_BYTES) throw new Error('Stored checkpoint body exceeds its byte limit or is missing');
  return cloneCheckpointValue(JSON.parse(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
