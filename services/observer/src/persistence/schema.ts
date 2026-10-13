import type { DatabaseSync } from 'node:sqlite';
import { conversationTitle } from '../conversation/title.js';

/** Local format migrations preserve existing content; unknown versions never create an empty conversation. */
export function initializeSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 3) return;
  if (version === 1 || version === 2) {
    migrateConversations(database, version === 1);
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
  migrateConversations(database);
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

function migrateConversations(database: DatabaseSync, addInteractions = false): void {
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ${addInteractions ? interactions : ''}
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        transcript_id TEXT NOT NULL UNIQUE REFERENCES transcripts(id),
        memories_id TEXT NOT NULL UNIQUE REFERENCES memory_sets(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO conversations(id, title, transcript_id, memories_id, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), '新对话', transcript_id, memories_id, unixepoch() * 1000, unixepoch() * 1000 FROM metadata;
      CREATE TABLE conversation_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), default_id TEXT NOT NULL REFERENCES conversations(id)) STRICT;
      INSERT INTO conversation_settings SELECT 1, id FROM conversations LIMIT 1;
      ALTER TABLE record_sources ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
      UPDATE record_sources SET conversation_id = (SELECT default_id FROM conversation_settings WHERE singleton = 1);
      DROP TABLE metadata;
      PRAGMA user_version = 3;
    `);
    for (const row of database.prepare('SELECT id, transcript_id FROM conversations').all()) {
      const first = database.prepare("SELECT body FROM messages WHERE transcript_id = ? AND json_extract(body, '$.role') = 'user' ORDER BY position LIMIT 1").get(row.transcript_id!);
      const title = conversationTitle(first ? [JSON.parse(first.body as string)] : []);
      database.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, row.id!);
    }
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
