import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Called inside the store transaction. Current identity rows survive body retirement;
 * older table formats are rejected without rewriting their content. */
/** Read-only format check, also used before opening a host for writes. */
export function inspectCheckpointTables(database: DatabaseSync): void {
  const images = database.prepare('PRAGMA table_xinfo(checkpoint_images)').all();
  const heads = database.prepare('PRAGMA table_xinfo(checkpoint_heads)').all();
  if (!images.length && !heads.length) return;
  checkTables(database, images, heads);
  indexHeads(database, false);
}

export function initializeCheckpointSchema(database: DatabaseSync): void {
  const images = database.prepare('PRAGMA table_xinfo(checkpoint_images)').all();
  const heads = database.prepare('PRAGMA table_xinfo(checkpoint_heads)').all();
  if (!images.length && !heads.length) {
    database.exec(tables('checkpoint_images', 'checkpoint_heads'));
    indexHeads(database);
    return;
  }
  checkTables(database, images, heads);
  indexHeads(database);
}

function indexHeads(database: DatabaseSync, create = true): void {
  // Avoid scanning every invocation head for each retained identity row.
  // A same-named index is not proof that it indexes the expected table or column.
  const existing = database.prepare('SELECT type, tbl_name FROM sqlite_master WHERE name = ?').get('checkpoint_heads_image');
  if (!existing) {
    if (create) database.exec('CREATE INDEX checkpoint_heads_image ON checkpoint_heads(image_id)');
    return;
  }
  const index = database
    .prepare('PRAGMA index_list(checkpoint_heads)')
    .all()
    .find((row) => row.name === 'checkpoint_heads_image');
  if (existing.type !== 'index' || existing.tbl_name !== 'checkpoint_heads' || index?.unique !== 0 || index.origin !== 'c' || index.partial !== 0 || !indexColumns(database, 'checkpoint_heads_image', ['image_id'])) throw new Error('Unknown checkpoint head index');
}

function checkTables(database: DatabaseSync, images: Row[], heads: Row[]): void {
  if (
    !columns(images, [
      ['id', 'TEXT', 0, 1],
      ['context_id', 'TEXT', 1, 0],
      ['revision', 'INTEGER', 1, 0],
      ['body', 'TEXT', 0, 0],
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
