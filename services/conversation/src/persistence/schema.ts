import type { DatabaseSync } from 'node:sqlite';
import { CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import { z } from 'zod';
import { encodeCheckpointStorage } from './checkpoint-storage.js';
import { inspectArchiveUsage, installArchiveUsage, removeArchiveUsageForMigration } from './budget.js';
import { retainCheckpointHeads } from './checkpoint-migration.js';

const applicationId = 0x43415043;
const version = 7;
const contentTables = ['content', 'messages', 'memories', 'append_receipts', 'apply_receipts'];
const recoveryTables = ['checkpoint_images', 'checkpoint_heads', 'completion_interactions'];
const exchangeTables = ['model_exchanges', 'model_exchange_entries', 'model_exchange_operations'];
const factsTables = ['checkpoint_values', 'checkpoint_relations'];
const columns: Readonly<Record<string, readonly string[]>> = {
  content: ['singleton', 'transcript_id', 'transcript_revision', 'starts', 'message_count', 'memories_id', 'memory_sequence', 'view_revision', 'view_state'],
  messages: ['position', 'body'],
  memories: ['ordinal', 'id', 'body'],
  append_receipts: ['ordinal', 'operation', 'body'],
  apply_receipts: ['ordinal', 'operation', 'body'],
  checkpoint_images: ['id', 'context_id', 'revision', 'body'],
  checkpoint_heads: ['context_id', 'revision', 'image_id', 'delivery'],
  checkpoint_values: ['context_id', 'id', 'metadata', 'body'],
  checkpoint_relations: ['context_id', 'child_id', 'ordinal', 'body'],
  completion_interactions: ['id', 'revision', 'body'],
  model_exchanges: ['id', 'sequence', 'bytes', 'entry_count', 'metadata'],
  model_exchange_entries: ['collection', 'id', 'ordinal', 'revision', 'body'],
  model_exchange_operations: ['collection', 'operation', 'exchange_id', 'call_id'],
  archive_usage: ['singleton', 'exchanges_bytes', 'interactions_bytes', 'checkpoint_bytes'],
};
const legacyExchangeColumns: Readonly<Record<string, readonly string[]>> = { model_exchanges: ['singleton', 'id', 'sequence', 'bytes'], model_exchange_entries: ['id', 'ordinal', 'revision', 'body'], model_exchange_operations: ['operation', 'exchange_id', 'call_id'] };
const integers = new Set(['singleton', 'transcript_revision', 'message_count', 'memory_sequence', 'view_revision', 'position', 'ordinal', 'revision', 'sequence', 'bytes', 'entry_count', 'exchanges_bytes', 'interactions_bytes', 'checkpoint_bytes']);
const legacyIdentity = z.object({ id: z.string().min(1), frame: z.object({ owner: z.object({ contextId: z.string().min(1) }) }) });

/** Identify the database before changing journal mode or installing any tables. */
export function inspectSchema(database: DatabaseSync): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const application = database.prepare('PRAGMA application_id').get()?.application_id;
  const savedVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  const names = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const object = database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (application === 0 && savedVersion === 0 && !object) return 0;
  if (application !== applicationId || (savedVersion !== 1 && savedVersion !== 2 && savedVersion !== 3 && savedVersion !== 4 && savedVersion !== 5 && savedVersion !== 6 && savedVersion !== version)) throw new Error('Unsupported conversation content database');
  const tables = savedVersion === 1 ? contentTables : [...contentTables, ...recoveryTables, ...(savedVersion >= 4 ? exchangeTables : []), ...(savedVersion >= 5 ? ['archive_usage'] : []), ...(savedVersion >= 7 ? factsTables : [])];
  if (names.length !== tables.length || [...tables].sort().some((name, index) => names[index] !== name)) throw new Error('Unsupported conversation content database');
  const descriptions = database.prepare('PRAGMA table_list').all();
  for (const table of tables) {
    const expected = savedVersion === 4 && legacyExchangeColumns[table] ? legacyExchangeColumns[table]! : columns[table]!;
    const actual = database.prepare(`PRAGMA table_info(${table})`).all();
    const description = descriptions.find((row) => row.schema === 'main' && row.name === table);
    if (
      description?.strict !== 1 ||
      description.ncol !== expected.length ||
      actual.length !== expected.length ||
      actual.some((row, index) => {
        const name = expected[index]!;
        const type = integers.has(name) ? 'INTEGER' : 'TEXT';
        const nullable = name === 'delivery' || name === 'call_id' || (name === 'metadata' && table === 'model_exchanges') || ((table === 'checkpoint_values' || (savedVersion >= 6 && table === 'checkpoint_images')) && name === 'body') || (index === 0 && type === 'INTEGER');
        const compound = savedVersion >= 5 && (table === 'model_exchange_entries' || table === 'model_exchange_operations' || factsTables.includes(table));
        const primary = compound && index < 2 ? index + 1 : index === 0 ? 1 : 0;
        return row.name !== name || row.type !== type || row.pk !== primary || row.notnull !== (nullable ? 0 : 1) || row.dflt_value !== null;
      })
    )
      throw new Error('Unsupported conversation table shape');
  }
  if (savedVersion >= 5) inspectArchiveUsage(database);
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
export function migrateSchema(database: DatabaseSync, previous: 1 | 2 | 3 | 4 | 5 | 6 | 7): void {
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
  // Convert storage before head retention; every body is validated before it is released.
  // Row-at-a-time iteration bounds migration memory instead of loading the whole history.
  if (previous <= 2) {
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
  }
  if (previous < 4)
    database.exec(`
    CREATE TABLE model_exchanges (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      bytes INTEGER NOT NULL CHECK (bytes >= 0)
    ) STRICT;
    CREATE TABLE model_exchange_entries (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE model_exchange_operations (
      operation TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL REFERENCES model_exchange_entries(id),
      call_id TEXT
    ) STRICT;
  `);
  if (previous < 5) migrateExchanges(database);
  else removeArchiveUsageForMigration(database);
  if (previous < 6) retainCheckpointHeads(database);
  database.exec(`
    CREATE TABLE checkpoint_values (
      context_id TEXT NOT NULL, id TEXT NOT NULL,
      metadata TEXT NOT NULL CHECK(json_valid(metadata)),
      body TEXT CHECK(body IS NULL OR json_valid(body)),
      PRIMARY KEY(context_id,id)
    ) STRICT;
    CREATE TABLE checkpoint_relations (
      context_id TEXT NOT NULL, child_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      body TEXT NOT NULL CHECK(json_valid(body)),
      PRIMARY KEY(context_id,child_id), UNIQUE(context_id,ordinal)
    ) STRICT;
  `);
  installArchiveUsage(database);
  database.exec(`PRAGMA user_version = ${version};`);
}

/** Preserve the old collection verbatim, without inventing source or policy metadata. */
function migrateExchanges(database: DatabaseSync): void {
  const orphan = database.prepare('SELECT 1 FROM model_exchange_entries WHERE NOT EXISTS (SELECT 1 FROM model_exchanges) UNION ALL SELECT 1 FROM model_exchange_operations WHERE NOT EXISTS (SELECT 1 FROM model_exchanges) LIMIT 1').get();
  if (orphan) throw new Error('Model exchange collection identity is missing');
  database.exec(`
    ALTER TABLE model_exchanges RENAME TO old_model_exchanges;
    ALTER TABLE model_exchange_entries RENAME TO old_model_exchange_entries;
    ALTER TABLE model_exchange_operations RENAME TO old_model_exchange_operations;
    CREATE TABLE model_exchanges (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
      metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata))
    ) STRICT;
    CREATE TABLE model_exchange_entries (
      collection TEXT NOT NULL REFERENCES model_exchanges(id),
      id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      body TEXT NOT NULL CHECK (json_valid(body)),
      PRIMARY KEY (collection, id),
      UNIQUE (collection, ordinal)
    ) STRICT;
    CREATE TABLE model_exchange_operations (
      collection TEXT NOT NULL REFERENCES model_exchanges(id),
      operation TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      call_id TEXT,
      PRIMARY KEY (collection, operation),
      FOREIGN KEY (collection, exchange_id) REFERENCES model_exchange_entries(collection, id)
    ) STRICT;
    INSERT INTO model_exchanges SELECT id, sequence, bytes, (SELECT COUNT(*) FROM old_model_exchange_entries), NULL FROM old_model_exchanges;
    INSERT INTO model_exchange_entries SELECT c.id, e.id, e.ordinal, e.revision, e.body FROM old_model_exchange_entries e CROSS JOIN old_model_exchanges c;
    INSERT INTO model_exchange_operations SELECT c.id, o.operation, o.exchange_id, o.call_id FROM old_model_exchange_operations o CROSS JOIN old_model_exchanges c;
    DROP TABLE old_model_exchange_operations;
    DROP TABLE old_model_exchange_entries;
    DROP TABLE old_model_exchanges;
  `);
}

function parseLegacy(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CHECKPOINT_MAX_BYTES) throw new Error('Persisted checkpoint exceeds its byte limit');
  return JSON.parse(value);
}
