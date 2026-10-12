import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, fchmodSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RuntimeError } from '@capix/server-runtime';
import { snapshotValue } from '@capix/server-runtime/recording';
import type { TranscriptState, TranscriptCommit, TranscriptPersistence, MemoriesState, MemoriesCommit, MemoriesPersistence } from '@capix/server-runtime/content';
import type { ConversationFailure, RecordChangeEvent, RecordEntry, CompositeRecord, RecordingArchive } from '@capix/protocol';
import type { ObserverStoredState } from './types.js';
import { initializeSchema } from './schema.js';
import { updateRecord } from './records.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Single-process local storage. Content commits are required; recording has its own integrity. */
export class SqliteObserverStore {
  readonly transcript: TranscriptPersistence = { commit: (change) => this.commitTranscript(change) };
  readonly memories: MemoriesPersistence = { commit: (change) => this.commitMemories(change) };
  readonly #database: DatabaseSync;
  #failure?: ConversationFailure;
  #activeSource?: string;
  readonly #failedSources = new Set<string>();
  #closed = false;

  private constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true });
    try {
      // Hold the writer lock across transactions; a second service cannot load an independent writer.
      this.#database.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE; COMMIT;');
      initializeSchema(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  static open(path: string): SqliteObserverStore {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    // SQLite sidecars inherit the database mode, so restrict it before the first WAL write.
    const descriptor = openSync(absolute, 'a', 0o600);
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(absolute + suffix)) chmodSync(absolute + suffix, 0o600);
    return new SqliteObserverStore(absolute);
  }

  get failure(): ConversationFailure | undefined {
    return this.#failure ?? (this.#closed ? Object.freeze({ code: 'PERSISTENCE_UNAVAILABLE', message: '内容存储已关闭。' }) : undefined);
  }

  /** One consistent read. Only a completely empty database represents a new conversation. */
  load(): ObserverStoredState | undefined {
    return this.transaction(() => {
      if (this.all('PRAGMA quick_check').some((row) => row.quick_check !== 'ok') || this.get('PRAGMA foreign_key_check')) throw new Error('Stored database integrity check failed');
      const metadata = this.get('SELECT transcript_id, memories_id FROM metadata WHERE singleton = 1');
      if (!metadata) {
        for (const table of ['transcripts', 'messages', 'memory_sets', 'memories', 'record_sources', 'records']) {
          if (this.get(`SELECT 1 FROM ${table} LIMIT 1`)) throw new Error('Persistence metadata is missing');
        }
        return undefined;
      }
      if (this.get('SELECT count(*) AS count FROM transcripts')?.count !== 1 || this.get('SELECT count(*) AS count FROM memory_sets')?.count !== 1) throw new Error('Unexpected content collections');
      const transcript = this.get('SELECT id, revision, starts FROM transcripts WHERE id = ?', metadata.transcript_id!);
      const memories = this.get('SELECT id, transcript_id, sequence FROM memory_sets WHERE id = ?', metadata.memories_id!);
      if (!transcript || !memories || memories.transcript_id !== transcript.id) throw new Error('Stored content identities do not match');
      const messages = this.all('SELECT position, body FROM messages WHERE transcript_id = ? ORDER BY position', transcript.id!);
      if (messages.some((row, index) => row.position !== index)) throw new Error('Stored message indexes are not continuous');
      const items = this.all('SELECT id, body FROM memories WHERE collection_id = ? ORDER BY ordinal', memories.id!).map((row) => {
        const data = parse(row.body);
        if (data.id !== row.id) throw new Error('Stored memory identity does not match');
        return data;
      });
      const archives: RecordingArchive[] = this.all('SELECT id, revision, roots, state FROM record_sources ORDER BY rowid').map((row) => ({ sourceId: row.id as string, revision: row.revision as number, rootIds: parse(row.roots), state: row.state as RecordingArchive['state'] }));
      const records = this.all('SELECT id, source_id, kind, body FROM records ORDER BY ordinal');
      const byId = new Map(records.map((row) => [row.id, row]));
      const entries = records.map((row) => {
        const data = parse(row.body);
        if (data.id !== row.id) throw new Error('Stored record identity does not match');
        if (data.parentId && byId.get(data.parentId)?.source_id !== row.source_id) throw new Error('Record parent belongs to a different source');
        return { kind: row.kind, data } as RecordEntry;
      });
      for (const archive of archives) {
        const roots = records.filter((row) => row.source_id === archive.sourceId && row.kind === 'runtime').map((row) => row.id);
        if (!Array.isArray(archive.rootIds) || roots.length !== archive.rootIds.length || roots.some((id, index) => id !== archive.rootIds[index])) throw new Error('Stored recording roots do not match');
        if (archive.revision < roots.length || !Number.isSafeInteger(archive.revision)) throw new Error('Invalid stored recording revision');
      }
      return {
        version: 1,
        transcript: { id: transcript.id as string, revision: transcript.revision as number, starts: parse(transcript.starts), messages: messages.map((row) => parse(row.body)) },
        memories: { id: memories.id as string, transcriptId: transcript.id as string, sequence: memories.sequence as number, items },
        recording: { book: { entries }, archives },
      };
    });
  }

  /** Initial identities are generated by the entities and installed together before any runtime binds. */
  initialize(content: { transcript: TranscriptState; memories: MemoriesState }): void {
    this.transaction(() => {
      if (this.get('SELECT 1 FROM metadata')) throw new Error('Observer content is already initialized');
      const transcript = content.transcript;
      const memories = content.memories;
      if (memories.transcriptId !== transcript.id) throw new Error('Memory source does not match transcript');
      this.run('INSERT INTO transcripts(id, revision, starts) VALUES (?, ?, ?)', transcript.id, transcript.revision, encode(transcript.starts));
      for (const [index, message] of transcript.messages.entries()) this.run('INSERT INTO messages(transcript_id, position, body) VALUES (?, ?, ?)', transcript.id, index, encode(message));
      this.run('INSERT INTO memory_sets(id, transcript_id, sequence) VALUES (?, ?, ?)', memories.id, transcript.id, memories.sequence);
      for (const memory of memories.items) this.run('INSERT INTO memories(id, collection_id, body) VALUES (?, ?, ?)', memory.id, memories.id, encode(memory));
      this.run('INSERT INTO metadata(singleton, transcript_id, memories_id) VALUES (1, ?, ?)', transcript.id, memories.id);
    });
  }

  private commitTranscript(change: TranscriptCommit): undefined {
    this.requireContent();
    this.transaction(() => {
      const row = this.get('SELECT revision, starts FROM transcripts WHERE id = ?', change.transcriptId);
      if (!row || row.revision !== change.expectedRevision || change.revision !== change.expectedRevision + 1) throw new Error('Transcript revision does not match saved state');
      const length = this.get('SELECT count(*) AS count FROM messages WHERE transcript_id = ?', change.transcriptId)!.count as number;
      const starts: number[] = parse(row.starts);
      if (change.kind === 'append') {
        if (change.start !== length || !change.messages.length) throw new Error('Transcript append boundary does not match');
        for (const [index, message] of change.messages.entries()) this.run('INSERT INTO messages(transcript_id, position, body) VALUES (?, ?, ?)', change.transcriptId, length + index, encode(message));
      } else {
        if (change.start <= starts.at(-1)! || change.start >= length) throw new Error('Transcript segment boundary does not match');
        starts.push(change.start);
      }
      this.run('UPDATE transcripts SET revision = ?, starts = ? WHERE id = ?', change.revision, encode(starts), change.transcriptId);
    });
  }

  private commitMemories(change: MemoriesCommit): undefined {
    this.requireContent();
    this.transaction(() => {
      const row = this.get('SELECT transcript_id, sequence FROM memory_sets WHERE id = ?', change.memoriesId);
      if (!row || row.transcript_id !== change.transcriptId || row.sequence !== change.expectedSequence || change.sequence !== change.expectedSequence + change.upserts.length || !change.upserts.length) throw new Error('Memory sequence does not match saved state');
      const ids = new Set<string>();
      for (const memory of change.upserts) {
        if (ids.has(memory.id)) throw new Error('Duplicate memory mutation');
        ids.add(memory.id);
        const previous = this.get('SELECT collection_id FROM memories WHERE id = ?', memory.id);
        if (previous && previous.collection_id !== change.memoriesId) throw new Error('Memory belongs to another collection');
        this.run('INSERT INTO memories(id, collection_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', memory.id, change.memoriesId, encode(memory));
      }
      this.run('UPDATE memory_sets SET sequence = ? WHERE id = ?', change.sequence, change.memoriesId);
    });
  }

  openRecording(sourceId: string): void {
    if (this.#activeSource) throw new Error('This store already has a recording writer');
    this.transaction(() => {
      if (!this.get('SELECT 1 FROM metadata')) throw new Error('Content must be initialized before recording');
      this.run("INSERT INTO record_sources(id, revision, roots, state) VALUES (?, 0, '[]', 'open')", sourceId);
    });
    this.#activeSource = sourceId;
  }

  applyRecordChange(event: RecordChangeEvent): void {
    if (this.#activeSource !== event.recorderId || this.#failedSources.has(event.recorderId)) throw new Error('Recording source is not writable');
    try {
      this.transaction(() => {
        const source = this.get('SELECT revision, state, roots FROM record_sources WHERE id = ?', event.recorderId);
        if (!source || source.state !== 'open' || source.revision !== event.revision - 1) throw new Error('Record revision does not match saved state');
        const mutation = event.change;
        if (mutation.kind === 'added') {
          const entry = mutation.entry;
          this.run('INSERT INTO records(id, source_id, kind, body) VALUES (?, ?, ?, ?)', entry.data.id, event.recorderId, entry.kind, encode(entry.data));
          if (mutation.parent) {
            if (entry.data.parentId !== mutation.parent.id || entry.data.id !== mutation.parent.childId) throw new Error('Record attachment does not match');
            const parent = this.readRecord(mutation.parent.id, event.recorderId);
            const body = parent.data as CompositeRecord;
            if (!Array.isArray(body.childIds) || body.childIds.includes(entry.data.id)) throw new Error('Invalid record parent');
            this.saveRecord({ kind: parent.kind, data: { ...body, childIds: [...body.childIds, entry.data.id] } } as RecordEntry);
          } else if (entry.data.parentId) throw new Error('Missing parent attachment');
          if (entry.kind === 'runtime') {
            const roots: string[] = parse(source.roots);
            roots.push(entry.data.id);
            this.run('UPDATE record_sources SET roots = ? WHERE id = ?', encode(roots), event.recorderId);
          }
        } else if (mutation.kind === 'replaced') {
          const previous = this.readRecord(mutation.entry.data.id, event.recorderId);
          if (previous.kind !== mutation.entry.kind || previous.data.parentId !== mutation.entry.data.parentId) throw new Error('Record replacement changes identity');
          this.saveRecord(mutation.entry);
        } else {
          this.saveRecord(updateRecord(this.readRecord(mutation.id, event.recorderId), mutation));
        }
        this.run('UPDATE record_sources SET revision = ? WHERE id = ?', event.revision, event.recorderId);
      }, false);
    } catch (error) {
      this.invalidateRecording(event.recorderId);
      throw error;
    }
  }

  invalidateRecording(sourceId: string): void {
    if (this.#failedSources.has(sourceId)) return;
    this.#failedSources.add(sourceId);
    try {
      this.transaction(() => this.run("UPDATE record_sources SET state = 'incomplete' WHERE id = ? AND state = 'open'", sourceId), false);
    } catch {
      // The durable 'open' marker remains an honest unknown when the disk cannot save this fault.
    }
  }

  sealRecording(sourceId: string, revision: number): void {
    if (this.#failedSources.has(sourceId)) return;
    this.transaction(() => {
      const row = this.get('SELECT revision, state FROM record_sources WHERE id = ?', sourceId);
      if (!row || row.state !== 'open' || row.revision !== revision || sourceId !== this.#activeSource) throw new Error('Cannot seal an unconfirmed recording source');
      this.run("UPDATE record_sources SET state = 'sealed' WHERE id = ?", sourceId);
    }, false);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  private readRecord(id: string, sourceId: string): RecordEntry {
    const row = this.get('SELECT kind, body FROM records WHERE id = ? AND source_id = ?', id, sourceId);
    if (!row) throw new Error('Saved record does not exist in this source');
    return { kind: row.kind as RecordEntry['kind'], data: parse(row.body) };
  }

  private saveRecord(entry: RecordEntry): void {
    this.run('UPDATE records SET body = ? WHERE id = ?', encode(entry.data), entry.data.id);
  }

  private requireContent(): void {
    if (this.#failure || this.#closed) throw new RuntimeError('PERSISTENCE_UNAVAILABLE', '内容存储不可用，请检查服务后重新加载。');
  }

  private transaction<Value>(work: () => Value, required = true): Value {
    if (this.#closed) throw new Error('Observer store is closed');
    let begun = false;
    try {
      this.#database.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (cause) {
      let error = cause;
      if (begun && this.#database.isTransaction) {
        try {
          this.#database.exec('ROLLBACK');
        } catch (rollback) {
          error = new AggregateError([cause, rollback], 'Persistence transaction and rollback failed');
          this.failContent();
        }
      }
      if (required || databaseUnavailable(cause)) this.failContent();
      throw new RuntimeError('PERSISTENCE_UNAVAILABLE', '数据保存或加载失败，请检查服务存储。', undefined, { cause: error });
    }
  }

  private failContent(): void {
    this.#failure ??= Object.freeze({ code: 'PERSISTENCE_UNAVAILABLE', message: '内容存储不可用，请检查服务后重新加载。' });
  }

  private get(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.#database.prepare(sql).get(...values);
  }

  private all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.#database.prepare(sql).all(...values);
  }

  private run(sql: string, ...values: SQLInputValue[]): void {
    this.#database.prepare(sql).run(...values);
  }
}

function encode(value: unknown): string {
  return JSON.stringify(snapshotValue(value));
}

function parse(value: unknown): any {
  if (typeof value !== 'string') throw new TypeError('Stored body must be JSON text');
  return JSON.parse(value);
}

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number') return false;
  return new Set([5, 6, 8, 10, 11, 13, 14, 26]).has(error.errcode & 255);
}
