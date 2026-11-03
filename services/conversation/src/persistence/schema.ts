import type { DatabaseSync } from 'node:sqlite';

const applicationId = 0x43415043;
const version = 1;
const tables = ['content', 'messages', 'memories', 'append_receipts', 'apply_receipts'];

/** Identify the database before changing journal mode or installing any tables. */
export function inspectSchema(database: DatabaseSync): boolean {
  const application = database.prepare('PRAGMA application_id').get()?.application_id;
  const savedVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  const names = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  const object = database.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (application === 0 && savedVersion === 0 && !object) return false;
  if (application !== applicationId || savedVersion !== version || names.length !== tables.length || [...tables].sort().some((name, index) => names[index] !== name)) throw new Error('Unsupported conversation content database');
  return true;
}

/** One content set per database. This format deliberately contains no invocation or queue state. */
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
    PRAGMA user_version = ${version};
  `);
}
