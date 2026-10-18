import type { DatabaseSync } from 'node:sqlite';
import { conversationTitle } from '../conversation/title.js';
import { initialActiveContent } from '../conversation/content/active.js';

/** Local format migrations preserve existing content; unknown versions never create an empty conversation. */
export function initializeSchema(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version === 6) return;
  if (version === 5) {
    migrateActiveContent(database);
    return;
  }
  if (version === 4) {
    migrateFixedEffects(database);
    migrateActiveContent(database);
    return;
  }
  if (version === 3) {
    migrateTranscriptAppends(database);
    migrateFixedEffects(database);
    migrateActiveContent(database);
    return;
  }
  if (version === 1 || version === 2) {
    migrateConversations(database, version === 1);
    migrateTranscriptAppends(database);
    migrateFixedEffects(database);
    migrateActiveContent(database);
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
  migrateTranscriptAppends(database);
  migrateFixedEffects(database);
  migrateActiveContent(database);
}

function migrateActiveContent(database: DatabaseSync): void {
  try {
    database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS active_content (
        transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id),
        memories_id TEXT NOT NULL UNIQUE REFERENCES memory_sets(id),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        body TEXT NOT NULL CHECK (json_valid(body))
      ) STRICT;`);
    for (const row of database.prepare('SELECT transcripts.id AS transcript_id, transcripts.starts, memory_sets.id AS memories_id FROM transcripts JOIN memory_sets ON memory_sets.transcript_id = transcripts.id WHERE NOT EXISTS (SELECT 1 FROM active_content WHERE active_content.transcript_id = transcripts.id)').all()) {
      const starts: number[] = JSON.parse(row.starts as string);
      const length = database.prepare('SELECT count(*) AS count FROM messages WHERE transcript_id = ?').get(row.transcript_id!)!.count as number;
      const ids = database
        .prepare('SELECT id FROM memories WHERE collection_id = ? ORDER BY ordinal')
        .all(row.memories_id!)
        .map((memory) => memory.id as string);
      const state = initialActiveContent(row.transcript_id as string, row.memories_id as string, starts.at(-1)!, length, ids);
      database.prepare('INSERT INTO active_content(transcript_id, memories_id, revision, body) VALUES (?, ?, ?, ?)').run(state.transcriptId, state.memoriesId, state.revision, JSON.stringify(state));
    }
    database.exec('PRAGMA user_version = 6; COMMIT;');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function migrateFixedEffects(database: DatabaseSync): void {
  try {
    database.exec(`
      BEGIN IMMEDIATE;
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
      PRAGMA user_version = 5;
      COMMIT;
    `);
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function migrateTranscriptAppends(database: DatabaseSync): void {
  try {
    database.exec(`
      BEGIN IMMEDIATE;
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
      PRAGMA user_version = 4;
      COMMIT;
    `);
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
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
