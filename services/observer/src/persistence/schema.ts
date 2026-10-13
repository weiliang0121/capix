import type { DatabaseSync } from 'node:sqlite';

/** Local format migrations preserve existing content; unknown versions never create an empty conversation. */
export function initializeSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 2) return;
  if (version === 1) {
    try {
      database.exec(`BEGIN IMMEDIATE; ${interactions} PRAGMA user_version = 2; COMMIT;`);
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
    return;
  }
  if (version !== 0 || database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Unsupported Observer persistence schema');
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      transcript_id TEXT NOT NULL,
      memories_id TEXT NOT NULL
    ) STRICT;
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
      state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'incomplete'))
    ) STRICT;
    CREATE TABLE records (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES record_sources(id),
      kind TEXT NOT NULL,
      body TEXT NOT NULL CHECK (json_valid(body))
    ) STRICT;
    ${interactions}
    PRAGMA user_version = 2;
    COMMIT;
  `);
}

const interactions = `
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    contract TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    request TEXT NOT NULL CHECK (json_valid(request)),
    body TEXT NOT NULL CHECK (json_valid(body))
  ) STRICT;
`;
