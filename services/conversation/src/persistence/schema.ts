import type { DatabaseSync } from 'node:sqlite';
import { CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import { z } from 'zod';
import { encodeCheckpointStorage } from './checkpoint-storage.js';

const applicationId = 0x43415043;
const version = 3;
const contentTables = ['content', 'messages', 'memories', 'append_receipts', 'apply_receipts'];
const recoveryTables = ['checkpoint_images', 'checkpoint_heads', 'completion_interactions'];
const columns: Readonly<Record<string, readonly string[]>> = {
  content: ['singleton', 'transcript_id', 'transcript_revision', 'starts', 'message_count', 'memories_id', 'memory_sequence', 'view_revision', 'view_state'],
  messages: ['position', 'body'],
  memories: ['ordinal', 'id', 'body'],
  append_receipts: ['ordinal', 'operation', 'body'],
  apply_receipts: ['ordinal', 'operation', 'body'],
  checkpoint_images: ['id', 'context_id', 'revision', 'body'],
  checkpoint_heads: ['context_id', 'revision', 'image_id', 'delivery'],
  completion_interactions: ['id', 'revision', 'body'],
};
const integers = new Set(['singleton', 'transcript_revision', 'message_count', 'memory_sequence', 'view_revision', 'position', 'ordinal', 'revision']);
const legacyIdentity = z.object({ id: z.string().min(1), frame: z.object({ owner: z.object({ contextId: z.string().min(1) }) }) });

/** Identify the database before changing journal mode or installing any tables. */
export function inspectSchema(database: DatabaseSync): 0 | 1 | 2 | 3 {
  const application = database.prepare('PRAGMA application_id').get()?.application_id;
  const savedVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  const names = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const object = database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (application === 0 && savedVersion === 0 && !object) return 0;
  if (application !== applicationId || (savedVersion !== 1 && savedVersion !== 2 && savedVersion !== version)) throw new Error('Unsupported conversation content database');
  const tables = savedVersion === 1 ? contentTables : [...contentTables, ...recoveryTables];
  if (names.length !== tables.length || [...tables].sort().some((name, index) => names[index] !== name)) throw new Error('Unsupported conversation content database');
  const descriptions = database.prepare('PRAGMA table_list').all();
  for (const table of tables) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all();
    const description = descriptions.find((row) => row.schema === 'main' && row.name === table);
    if (
      description?.strict !== 1 ||
      description.ncol !== columns[table]!.length ||
      actual.length !== columns[table]!.length ||
      actual.some((row, index) => {
        const name = columns[table]![index]!;
        const type = integers.has(name) ? 'INTEGER' : 'TEXT';
        const nullable = name === 'delivery' || (index === 0 && type === 'INTEGER');
        return row.name !== name || row.type !== type || row.pk !== (index === 0 ? 1 : 0) || row.notnull !== (nullable ? 0 : 1) || row.dflt_value !== null;
      })
    )
      throw new Error('Unsupported conversation table shape');
  }
  return savedVersion;
}

/** One content set per database; full invocation objects and queues are never persisted. */
export function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE content (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      transcript_id TEXT NOT NULL,
      transcript_revision INTEGER NOT NULL CHECK (transcript_revision >= 0),
      starts TEXT NOT NULL CHECK (json_valid(starts)),
      message_count INTEGER NOT NULL CHECK (message_count >= 0),
      memories_id TEXT NOT NULL,
      memory_sequence INTEGER NOT NULL CHECK (memory_sequence >= 0),
      view_revision INTEGER NOT NULL CHECK (view_revision >= 0),
      view_state TEXT NOT NULL CHECK (json_valid(view_state))
    ) STRICT;
    CREATE TABLE messages (
      position INTEGER PRIMARY KEY CHECK (position >= 0),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE memories (
      ordinal INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE append_receipts (
      ordinal INTEGER PRIMARY KEY,
      operation TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE apply_receipts (
      ordinal INTEGER PRIMARY KEY,
      operation TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    PRAGMA application_id = ${applicationId};
  `);
  migrateSchema(database, 1);
}

/** Called inside the opening exclusive transaction, preserving all v1 content and receipts. */
export function migrateSchema(database: DatabaseSync, previous: 1 | 2 | 3): void {
  if (previous === version) return;
  if (previous === 1)
    database.exec(`
    CREATE TABLE checkpoint_images (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      body TEXT NOT NULL CHECK (json_valid(body)),
      UNIQUE (context_id, revision)
    ) STRICT;
    CREATE TABLE checkpoint_heads (
      context_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      image_id TEXT NOT NULL UNIQUE REFERENCES checkpoint_images(id),
      delivery TEXT CHECK (delivery IS NULL OR json_valid(delivery))
    ) STRICT;
    CREATE TABLE completion_interactions (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
  `);
  // Retain every image ID/revision and all deliveries. Only the SQL representation changes.
  // Row-at-a-time iteration bounds migration memory instead of loading the whole history.
  const updateImage = database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?');
  for (const row of database.prepare('SELECT id, context_id, body FROM checkpoint_images ORDER BY rowid').iterate()) {
    const image = parseLegacy(row.body);
    const identity = legacyIdentity.parse(image);
    if (identity.id !== row.id || identity.frame.owner.contextId !== row.context_id) throw new Error('Legacy checkpoint identity differs from its row');
    // A storage migration does not certify v5 or discard opaque older Frames.
    // Ordinary checkpoint reads still perform the full current-format validation.
    updateImage.run(encodeCheckpointStorage(image), identity.id);
  }
  const updateDelivery = database.prepare('UPDATE checkpoint_heads SET delivery = ? WHERE context_id = ?');
  for (const row of database.prepare('SELECT context_id, delivery FROM checkpoint_heads WHERE delivery IS NOT NULL ORDER BY rowid').iterate()) {
    if (typeof row.context_id !== 'string') throw new Error('Legacy checkpoint context identity is missing');
    updateDelivery.run(encodeCheckpointStorage(parseLegacy(row.delivery)), row.context_id);
  }
  database.exec(`PRAGMA user_version = ${version};`);
}

function parseLegacy(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CHECKPOINT_MAX_BYTES) throw new Error('Persisted checkpoint exceeds its byte limit');
  return JSON.parse(value);
}
