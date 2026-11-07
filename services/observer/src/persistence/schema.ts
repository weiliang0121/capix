import type { DatabaseSync } from 'node:sqlite';

/** Create the current format only. Existing older stores require an explicit host reset. */
export function inspectSchema(database: DatabaseSync): boolean {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 6) return true;
  if (version !== 0 || database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Unsupported Observer persistence schema; existing data is not migrated');
  return false;
}

export function initializeSchema(database: DatabaseSync): void {
  if (inspectSchema(database)) return;
  try {
    database.exec(`
      BEGIN IMMEDIATE;
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      starts TEXT NOT NULL CHECK (json_valid(starts))
    ) STRICT;
    CREATE TABLE messages (
      transcript_id TEXT NOT NULL REFERENCES transcripts(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      body TEXT NOT NULL CHECK (json_valid(body)),
      PRIMARY KEY (transcript_id, position)
    ) STRICT;
    CREATE TABLE memory_sets (
      id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL REFERENCES transcripts(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 0)
    ) STRICT;
    CREATE TABLE memories (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      collection_id TEXT NOT NULL REFERENCES memory_sets(id),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE record_sources (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      roots TEXT NOT NULL CHECK (json_valid(roots)),
      state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'incomplete')),
      conversation_id TEXT REFERENCES conversations(id)
    ) STRICT;
    CREATE TABLE records (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES record_sources(id),
      kind TEXT NOT NULL,
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      transcript_id TEXT NOT NULL UNIQUE REFERENCES transcripts(id),
      memories_id TEXT NOT NULL UNIQUE REFERENCES memory_sets(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE conversation_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), default_id TEXT NOT NULL REFERENCES conversations(id)) STRICT;
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    contract TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    request TEXT NOT NULL CHECK (json_valid(request)),
    body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
      CREATE TABLE transcript_appends (
        transcript_id TEXT NOT NULL REFERENCES transcripts(id),
        parent_context_id TEXT NOT NULL,
        child_context_id TEXT NOT NULL,
        position TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        body TEXT NOT NULL CHECK (json_valid(body)),
        PRIMARY KEY (parent_context_id, child_context_id, position),
        UNIQUE (transcript_id, revision)
      ) STRICT;
      CREATE TABLE memory_applies (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        memories_id TEXT NOT NULL REFERENCES memory_sets(id),
        context_id TEXT NOT NULL,
        position TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        UNIQUE (context_id, position)
      ) STRICT;
      CREATE TABLE file_creations (
        context_id TEXT NOT NULL,
        position TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        PRIMARY KEY (context_id, position)
      ) STRICT;
    CREATE TABLE active_content (
      transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id),
      memories_id TEXT NOT NULL UNIQUE REFERENCES memory_sets(id),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
      PRAGMA user_version = 6;
      COMMIT;
    `);
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
