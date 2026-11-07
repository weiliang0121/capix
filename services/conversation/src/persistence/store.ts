import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { PersistenceError } from '@capix/diagnostics';
import type { MemoriesCommit, MemoriesPersistence, MemoryApplyState } from '@capix/memory';
import type { TranscriptAppendState, TranscriptCommit, TranscriptPersistence } from '@capix/transcript';
import type { ViewCommit, ViewPersistence } from '@capix/view';
import { z } from 'zod';
import { restoreConversationContent, type ConversationState } from '../assembly/content.js';
import type { ConversationMaterialSources } from '../materials/view.js';
import { createSchema, inspectSchema, migrateSchema } from './schema.js';
import { SqliteCheckpoints, type ConversationCheckpoints } from './checkpoints.js';
import { SqliteInteractions, type ConversationInteractions } from './interactions.js';
import { SqliteExchanges, type ConversationExchanges } from './exchanges.js';
import { RecoveryConflict } from './recovery.js';
import { readArchiveUsage, type ConversationArchiveUsage } from './budget.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metadata = z.object({ singleton: z.literal(1), transcript_id: z.string().min(1), transcript_revision: integer, starts: z.string(), message_count: integer, memories_id: z.string().min(1), memory_sequence: integer, view_revision: integer, view_state: z.string() }).strict();
const messageRow = z.object({ position: integer, body: z.string() }).strict();
const memoryRow = z.object({ ordinal: integer, id: z.string().min(1), body: z.string() }).strict();
const receiptRow = z.object({ ordinal: integer, operation: z.string(), body: z.string() }).strict();

/** A host-owned, single-writer database. Any uncertain store failure closes further admission. */
export class ConversationStore {
  readonly #database: DatabaseSync;
  #closed = false;
  #failure?: PersistenceError;

  readonly transcript: TranscriptPersistence = Object.freeze({ commit: (change: TranscriptCommit) => this.commitTranscript(change) });
  readonly memories: MemoriesPersistence = Object.freeze({ commit: (change: MemoriesCommit) => this.commitMemories(change) });
  readonly view: ViewPersistence<ConversationMaterialSources> = Object.freeze({ commit: (change: ViewCommit<ConversationMaterialSources>) => this.commitView(change) });
  readonly #checkpoints: Readonly<SqliteCheckpoints>;
  get checkpoints(): ConversationCheckpoints {
    return this.#checkpoints;
  }
  readonly interactions: ConversationInteractions;
  readonly exchanges: ConversationExchanges;

  static open(path: string): ConversationStore {
    const file = resolve(path);
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const descriptor = openSync(file, 'a', 0o600);
      closeSync(descriptor);
      database = new DatabaseSync(file, { timeout: 0, enableForeignKeyConstraints: true });
      const existing = inspectSchema(database);
      chmodSync(file, 0o600);
      // EXCLUSIVE remains held across transactions, preventing another host with stale entities.
      database.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE;');
      try {
        if (!existing) createSchema(database);
        else migrateSchema(database, existing);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
      return new ConversationStore(database);
    } catch (cause) {
      try {
        database?.close();
      } catch {
        /* Preserve the opening failure. */
      }
      throw new PersistenceError('conversation.open', cause);
    }
  }

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#checkpoints = Object.freeze(new SqliteCheckpoints(database, (operation, work) => this.transaction(operation, work, true)));
    this.interactions = Object.freeze(new SqliteInteractions(database, (operation, work) => this.transaction(operation, work, true)));
    this.exchanges = Object.freeze(new SqliteExchanges(database, (operation, work) => this.transaction(operation, work, true)));
  }

  assertAvailable(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new PersistenceError('conversation.closed', new Error('Conversation store is closed'));
  }

  /** Admission reads current retained facts; this is neither a quota reservation nor a commit gate. */
  archiveUsage(): ConversationArchiveUsage {
    return this.transaction('conversation.archive-usage', () => readArchiveUsage(this.#database));
  }

  load(): ConversationState | undefined {
    return this.transaction('conversation.load', () => {
      const integrity = this.#database.prepare('PRAGMA quick_check').all();
      if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('Conversation database integrity check failed');
      const row = this.#database.prepare('SELECT * FROM content').get();
      if (!row) {
        for (const table of ['messages', 'memories', 'append_receipts', 'apply_receipts', 'checkpoint_images', 'checkpoint_heads', 'checkpoint_values', 'checkpoint_relations', 'completion_interactions', 'model_exchanges', 'model_exchange_entries', 'model_exchange_operations']) if (this.#database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Content identities are missing from a nonempty database');
        return undefined;
      }
      const saved = metadata.parse(row);
      const messages = this.#database
        .prepare('SELECT * FROM messages ORDER BY position')
        .all()
        .map((value, index) => {
          const row = messageRow.parse(value);
          if (row.position !== index) throw new Error('Persisted message positions are not contiguous');
          return JSON.parse(row.body);
        });
      if (messages.length !== saved.message_count) throw new Error('Persisted message count does not match its content');
      const items = this.#database
        .prepare('SELECT * FROM memories ORDER BY ordinal')
        .all()
        .map((value) => {
          const row = memoryRow.parse(value);
          const item = JSON.parse(row.body);
          if (item?.id !== row.id) throw new Error('Persisted memory identity differs from its row');
          return item;
        });
      const appends = this.readAppends();
      const applies = this.readApplies();
      // JSON is untrusted here; entity restoration below checks all value and cross-entity invariants.
      const state: ConversationState = {
        transcript: { id: saved.transcript_id, revision: saved.transcript_revision, starts: JSON.parse(saved.starts), messages, ...(appends.length ? { appends } : {}) },
        memories: { id: saved.memories_id, transcriptId: saved.transcript_id, sequence: saved.memory_sequence, items, ...(applies.length ? { applies } : {}) },
        view: JSON.parse(saved.view_state),
      };
      if (state.view?.revision !== saved.view_revision) throw new Error('Persisted View revision differs from its metadata');
      return checkedState(state);
    });
  }

  initialize(state: ConversationState): void {
    this.transaction('conversation.initialize', () => {
      if (this.#database.prepare('SELECT 1 FROM content').get()) throw new Error('Conversation content already exists');
      for (const table of ['messages', 'memories', 'append_receipts', 'apply_receipts', 'checkpoint_images', 'checkpoint_heads', 'checkpoint_values', 'checkpoint_relations', 'completion_interactions', 'model_exchanges', 'model_exchange_entries', 'model_exchange_operations']) if (this.#database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Cannot initialize over orphaned content');
      const accepted = checkedState(state);
      this.#database.prepare('INSERT INTO content VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)').run(accepted.transcript.id, accepted.transcript.revision, JSON.stringify(accepted.transcript.starts), accepted.transcript.messages.length, accepted.memories.id, accepted.memories.sequence, accepted.view.revision, JSON.stringify(accepted.view));
      const append = this.#database.prepare('INSERT INTO messages VALUES (?, ?)');
      accepted.transcript.messages.forEach((message, index) => append.run(index, JSON.stringify(message)));
      const memory = this.#database.prepare('INSERT INTO memories (id, body) VALUES (?, ?)');
      for (const item of accepted.memories.items) memory.run(item.id, JSON.stringify(item));
      for (const fixed of accepted.transcript.appends ?? []) this.appendReceipt(fixed);
      for (const fixed of accepted.memories.applies ?? []) this.applyReceipt(fixed);
    });
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#database.close();
      this.#closed = true;
    } catch (cause) {
      throw this.fail('conversation.close', cause);
    } finally {
      this.#checkpoints.clearCache();
    }
  }

  private commitTranscript(change: TranscriptCommit): undefined {
    this.transaction('transcript.commit', () => {
      const saved = this.requireContent();
      if (saved.transcript_id !== change.transcriptId || saved.transcript_revision !== change.expectedRevision || change.revision !== change.expectedRevision + 1) throw new Error('Transcript persistence revision or identity conflict');
      if (change.kind === 'append') {
        if (change.start !== saved.message_count) throw new Error('Transcript persistence append position conflict');
        if (!change.messages.length) throw new Error('Cannot persist an empty append');
        const insert = this.#database.prepare('INSERT INTO messages VALUES (?, ?)');
        change.messages.forEach((message, offset) => insert.run(change.start + offset, JSON.stringify(message)));
        this.#database.prepare('UPDATE content SET transcript_revision = ?, message_count = ? WHERE singleton = 1').run(change.revision, saved.message_count + change.messages.length);
        if (change.fixed) this.appendReceipt(change.fixed);
      } else if (change.kind === 'start-segment') {
        const starts: number[] = JSON.parse(saved.starts);
        if (!Number.isSafeInteger(change.start) || change.start >= saved.message_count || starts.at(-1)! >= change.start) throw new Error('Invalid persisted segment boundary');
        this.#database.prepare('UPDATE content SET transcript_revision = ?, starts = ? WHERE singleton = 1').run(change.revision, JSON.stringify([...starts, change.start]));
      } else throw new Error('Unknown transcript persistence mutation');
    });
    return undefined;
  }

  private commitMemories(change: MemoriesCommit): undefined {
    this.transaction('memories.commit', () => {
      const saved = this.requireContent();
      if (change.memoriesId !== saved.memories_id || change.transcriptId !== saved.transcript_id || change.expectedSequence !== saved.memory_sequence || change.sequence !== change.expectedSequence + change.upserts.length) throw new Error('Memory persistence sequence or identity conflict');
      const upsert = this.#database.prepare('INSERT INTO memories (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body');
      const ids = new Set<string>();
      for (const memory of change.upserts) {
        if (ids.has(memory.id)) throw new Error('Duplicate memory target in one commit');
        ids.add(memory.id);
        upsert.run(memory.id, JSON.stringify(memory));
      }
      this.#database.prepare('UPDATE content SET memory_sequence = ? WHERE singleton = 1').run(change.sequence);
      if (change.fixed) this.applyReceipt(change.fixed);
    });
    return undefined;
  }

  private commitView(change: ViewCommit<ConversationMaterialSources>): undefined {
    this.transaction('view.commit', () => {
      const saved = this.requireContent();
      if (saved.view_revision !== change.previous.revision || change.state.revision !== change.previous.revision + 1 || !isDeepStrictEqual(JSON.parse(saved.view_state), change.previous) || !isDeepStrictEqual(change.state.sources, change.previous.sources)) throw new Error('View persistence revision or identity conflict');
      for (const [slot, stamp] of Object.entries(change.checkedSources)) {
        const id = slot === 'messages' ? saved.transcript_id : slot === 'memories' ? saved.memories_id : undefined;
        const version = slot === 'messages' ? saved.transcript_revision : saved.memory_sequence;
        if (!id || !stamp || stamp.id !== id || stamp.scope !== 'whole' || stamp.version !== String(version)) throw new Error('View persistence source version conflict');
      }
      this.#database.prepare('UPDATE content SET view_revision = ?, view_state = ? WHERE singleton = 1').run(change.state.revision, JSON.stringify(change.state));
    });
    return undefined;
  }

  private readAppends(): TranscriptAppendState[] {
    return this.#database
      .prepare('SELECT * FROM append_receipts ORDER BY ordinal')
      .all()
      .map((value) => {
        const row = receiptRow.parse(value);
        const fixed: TranscriptAppendState = JSON.parse(row.body);
        if (row.operation !== appendKey(fixed)) throw new Error('Persisted append operation differs from its row');
        return fixed;
      });
  }

  private readApplies(): MemoryApplyState[] {
    return this.#database
      .prepare('SELECT * FROM apply_receipts ORDER BY ordinal')
      .all()
      .map((value) => {
        const row = receiptRow.parse(value);
        const fixed: MemoryApplyState = JSON.parse(row.body);
        if (row.operation !== applyKey(fixed)) throw new Error('Persisted memory operation differs from its row');
        return fixed;
      });
  }

  private appendReceipt(fixed: TranscriptAppendState): void {
    this.#database.prepare('INSERT INTO append_receipts (operation, body) VALUES (?, ?)').run(appendKey(fixed), JSON.stringify(fixed));
  }

  private applyReceipt(fixed: MemoryApplyState): void {
    this.#database.prepare('INSERT INTO apply_receipts (operation, body) VALUES (?, ?)').run(applyKey(fixed), JSON.stringify(fixed));
  }

  private requireContent() {
    return metadata.parse(this.#database.prepare('SELECT * FROM content').get());
  }

  private transaction<T>(operation: string, work: () => T, allowConflict = false): T {
    this.assertAvailable();
    let started = false;
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      started = true;
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (cause) {
      if (started) {
        try {
          this.#database.exec('ROLLBACK');
        } catch (rollback) {
          throw this.fail(operation, new AggregateError([cause, rollback], 'Conversation commit and rollback failed'));
        }
      }
      if (allowConflict && cause instanceof RecoveryConflict) throw cause;
      throw this.fail(operation, cause);
    }
  }

  private fail(operation: string, cause: unknown): PersistenceError {
    this.#failure ??= cause instanceof PersistenceError ? cause : new PersistenceError(operation, cause);
    return this.#failure;
  }
}

function checkedState(state: ConversationState): ConversationState {
  const entities = restoreConversationContent(state);
  const accepted = Object.freeze({ transcript: entities.transcript.exportState(), memories: entities.memories.exportState(), view: entities.view.exportState() });
  if (!isDeepStrictEqual(state, accepted)) throw new Error('Persisted content contains unsupported fields or noncanonical values');
  return accepted;
}

function appendKey(fixed: TranscriptAppendState): string {
  const operation = fixed.request.operation;
  return JSON.stringify([operation.parentContextId, operation.childContextId, operation.position]);
}

function applyKey(fixed: MemoryApplyState): string {
  return JSON.stringify([fixed.request.operation.contextId, fixed.request.operation.position]);
}
