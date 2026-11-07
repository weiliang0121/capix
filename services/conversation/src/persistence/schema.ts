import type { DatabaseSync } from 'node:sqlite';
import { inspectArchiveUsage, installArchiveUsage } from './budget.js';

const applicationId = 0x43415043;
const version = 8;
const contentTables = ['content', 'messages', 'memories', 'append_receipts', 'apply_receipts'];
const recoveryTables = ['checkpoint_images', 'checkpoint_heads', 'completion_interactions'];
const exchangeTables = ['model_exchanges', 'model_exchange_entries', 'model_exchange_operations'];
const factsTables = ['checkpoint_values', 'checkpoint_relations'];
const selectionTables = ['checkpoint_selections', 'checkpoint_occurrences'];
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
  checkpoint_selections: ['context_id', 'id', 'body'],
  checkpoint_occurrences: ['context_id', 'selection_id', 'occurrence_id', 'ordinal', 'body'],
  completion_interactions: ['id', 'revision', 'body'],
  model_exchanges: ['id', 'sequence', 'bytes', 'entry_count', 'metadata'],
  model_exchange_entries: ['collection', 'id', 'ordinal', 'revision', 'body'],
  model_exchange_operations: ['collection', 'operation', 'exchange_id', 'call_id'],
  archive_usage: ['singleton', 'exchanges_bytes', 'interactions_bytes', 'checkpoint_bytes'],
};
const integers = new Set(['singleton', 'transcript_revision', 'message_count', 'memory_sequence', 'view_revision', 'position', 'ordinal', 'revision', 'sequence', 'bytes', 'entry_count', 'exchanges_bytes', 'interactions_bytes', 'checkpoint_bytes']);

/** Identify the database before changing journal mode or installing any tables. */
export function inspectSchema(database: DatabaseSync): 0 | 8 {
  const application = database.prepare('PRAGMA application_id').get()?.application_id;
  const savedVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  const names = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const object = database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (application === 0 && savedVersion === 0 && !object) return 0;
  if (application !== applicationId || savedVersion !== version) throw new Error('Unsupported conversation database version; create a new database explicitly instead of migrating existing data');
  const tables = [...contentTables, ...recoveryTables, ...exchangeTables, 'archive_usage', ...factsTables, ...selectionTables];
  if (names.length !== tables.length || [...tables].sort().some((name, index) => names[index] !== name)) throw new Error('Unsupported conversation content database');
  const descriptions = database.prepare('PRAGMA table_list').all();
  for (const table of tables) {
    const expected = columns[table]!;
    const actual = database.prepare(`PRAGMA table_info(${table})`).all();
    const description = descriptions.find((row) => row.schema === 'main' && row.name === table);
    if (
      description?.strict !== 1 ||
      description.ncol !== expected.length ||
      actual.length !== expected.length ||
      actual.some((row, index) => {
        const name = expected[index]!;
        const type = integers.has(name) ? 'INTEGER' : 'TEXT';
        const nullable = name === 'delivery' || name === 'call_id' || (name === 'metadata' && table === 'model_exchanges') || ((table === 'checkpoint_values' || table === 'checkpoint_occurrences' || table === 'checkpoint_images') && name === 'body') || (index === 0 && type === 'INTEGER');
        const compound = table === 'model_exchange_entries' || table === 'model_exchange_operations' || factsTables.includes(table) || selectionTables.includes(table);
        const primary = compound && index < (table === 'checkpoint_occurrences' ? 3 : 2) ? index + 1 : index === 0 ? 1 : 0;
        return row.name !== name || row.type !== type || row.pk !== primary || row.notnull !== (nullable ? 0 : 1) || row.dflt_value !== null;
      })
    )
      throw new Error('Unsupported conversation table shape');
  }
  inspectArchiveUsage(database);
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
    CREATE TABLE checkpoint_images (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      body TEXT CHECK (body IS NULL OR json_valid(body)),
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
    CREATE TABLE checkpoint_selections (
      context_id TEXT NOT NULL, id TEXT NOT NULL,
      body TEXT NOT NULL CHECK(json_valid(body)),
      PRIMARY KEY(context_id,id)
    ) STRICT;
    CREATE TABLE checkpoint_occurrences (
      context_id TEXT NOT NULL, selection_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      body TEXT CHECK(body IS NULL OR json_valid(body)),
      PRIMARY KEY(context_id,selection_id,occurrence_id), UNIQUE(context_id,selection_id,ordinal)
    ) STRICT;
    CREATE INDEX checkpoint_occurrences_active ON checkpoint_occurrences(context_id,selection_id,ordinal) WHERE body IS NOT NULL;
    PRAGMA application_id = ${applicationId};
    PRAGMA user_version = ${version};
  `);
  installArchiveUsage(database);
}
