import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, fchmodSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RuntimeError } from '@capix/contracts';
import type { InteractionCommit, InteractionState } from '@capix/server-runtime';
import { snapshotValue } from '@capix/records';
import { isEqual } from 'es-toolkit';
import type { TranscriptState, TranscriptCommit, TranscriptPersistence, TranscriptAppendState } from '@capix/transcript';
import type { MemoriesState, MemoriesCommit, MemoriesPersistence, MemoryApplyState } from '@capix/memory';
import type { FileCreationPersistence, FileCreationState } from '../files/creation.js';
import type { ConversationDescriptor, ConversationListResponse, ConversationFailure, RecordChangeEvent, RecordEntry, CompositeRecord, RecordingArchive } from '@capix/protocol';
import type { ObserverInteractionPersistence, ObserverStoredContent, ObserverStoredRecording } from './types.js';
import { conversationTitle } from '../conversation/title.js';
import { initializeSchema } from './schema.js';
import { updateRecord } from './records.js';
import { SqliteCheckpointStore } from './checkpoints.js';
import { SqliteConversationCheckpointRuns } from './runs.js';
import { appendActiveView, freezeActiveView, initialActiveView, type ActiveViewPersistence, type ActiveViewState } from '@capix/observer-content';

type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Single-process local storage. Content commits are required; recording has its own integrity. */
export class SqliteObserverStore {
  readonly transcript: TranscriptPersistence = { commit: (change) => this.commitTranscript(change) };
  readonly memories: MemoriesPersistence = { commit: (change) => this.commitMemories(change) };
  readonly activeView: ActiveViewPersistence = { commit: (change) => this.commitActiveView(change) };
  readonly interactions: ObserverInteractionPersistence = { create: (state) => this.createInteraction(state), commit: (change) => this.commitInteraction(change), read: (id) => this.readInteraction(id) };
  readonly checkpoints: SqliteCheckpointStore;
  readonly checkpointRuns: SqliteConversationCheckpointRuns;
  readonly fileCreations: FileCreationPersistence = { read: (operation) => this.readFileCreation(operation), create: (state) => this.createFileCreation(state), complete: (state) => this.completeFileCreation(state) };
  readonly #database: DatabaseSync;
  #failure?: ConversationFailure;
  readonly #activeSources = new Set<string>();
  readonly #failedSources = new Set<string>();
  #closed = false;

  private constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true });
    try {
      // Hold the writer lock across transactions; a second service cannot load an independent writer.
      this.#database.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN EXCLUSIVE; COMMIT;');
      initializeSchema(this.#database);
      this.checkpoints = new SqliteCheckpointStore(this.#database);
      this.checkpointRuns = new SqliteConversationCheckpointRuns(this.#database);
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

  list(): ConversationListResponse {
    return this.transaction(() => {
      const conversations = this.all('SELECT id, title, transcript_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC, rowid DESC').map(descriptor);
      const defaultConversationId = this.get('SELECT default_id FROM conversation_settings WHERE singleton = 1')?.default_id as string | undefined;
      if (conversations.length > 0 !== Boolean(defaultConversationId) || (defaultConversationId && !conversations.some((item) => item.id === defaultConversationId))) throw new Error('Invalid default conversation');
      return { conversations, defaultConversationId: defaultConversationId ?? '' };
    });
  }

  conversation(id: string): ConversationDescriptor | undefined {
    return this.transaction(() => {
      const row = this.get('SELECT id, title, transcript_id, created_at, updated_at FROM conversations WHERE id = ?', id);
      return row ? descriptor(row) : undefined;
    });
  }

  conversationForTranscript(id: string): ConversationDescriptor | undefined {
    return this.transaction(() => {
      const row = this.get('SELECT id, title, transcript_id, created_at, updated_at FROM conversations WHERE transcript_id = ?', id);
      return row ? descriptor(row) : undefined;
    });
  }

  /** Internal assembly identity check; no message, memory body or observation is loaded. */
  contentIdentity(id: string): { readonly transcriptId: string; readonly memoriesId: string } | undefined {
    return this.transaction(() => {
      const row = this.get('SELECT transcript_id, memories_id FROM conversations WHERE id = ?', id);
      return row ? Object.freeze({ transcriptId: row.transcript_id as string, memoriesId: row.memories_id as string }) : undefined;
    });
  }

  /** Required content is read consistently without querying or decoding historical recording. */
  loadContent(conversationId?: string): ObserverStoredContent | undefined {
    return this.transaction(() => {
      for (const table of ['conversations', 'conversation_settings', 'transcripts', 'messages', 'transcript_appends', 'memory_sets', 'memories', 'memory_applies', 'active_content']) {
        if (this.all(`PRAGMA quick_check(${table})`).some((row) => row.quick_check !== 'ok') || this.get(`PRAGMA foreign_key_check(${table})`)) throw new Error('Stored database integrity check failed');
      }
      if (this.get('SELECT count(*) AS count FROM transcripts')?.count !== this.get('SELECT count(*) AS count FROM conversations')?.count || this.get('SELECT count(*) AS count FROM memory_sets')?.count !== this.get('SELECT count(*) AS count FROM conversations')?.count || this.get('SELECT count(*) AS count FROM active_content')?.count !== this.get('SELECT count(*) AS count FROM conversations')?.count) throw new Error('Unowned content');
      const metadata = conversationId ? this.get('SELECT transcript_id, memories_id FROM conversations WHERE id = ?', conversationId) : this.get('SELECT transcript_id, memories_id FROM conversations WHERE id = (SELECT default_id FROM conversation_settings WHERE singleton = 1)');
      if (!metadata) {
        if (conversationId) throw new Error('Conversation does not exist');
        for (const table of ['transcripts', 'messages', 'transcript_appends', 'memory_sets', 'memories', 'memory_applies', 'active_content']) {
          if (this.get(`SELECT 1 FROM ${table} LIMIT 1`)) throw new Error('Persistence metadata is missing');
        }
        return undefined;
      }
      const transcript = this.get('SELECT id, revision, starts FROM transcripts WHERE id = ?', metadata.transcript_id!);
      const memories = this.get('SELECT id, transcript_id, sequence FROM memory_sets WHERE id = ?', metadata.memories_id!);
      if (!transcript || !memories || memories.transcript_id !== transcript.id) throw new Error('Stored content identities do not match');
      const messages = this.all('SELECT position, body FROM messages WHERE transcript_id = ? ORDER BY position', transcript.id!);
      if (messages.some((row, index) => row.position !== index)) throw new Error('Stored message indexes are not continuous');
      const appends = this.all('SELECT transcript_id, parent_context_id, child_context_id, position, revision, body FROM transcript_appends WHERE transcript_id = ? ORDER BY revision', transcript.id!).map((row) => {
        const state = parse(row.body) as TranscriptAppendState;
        if (state.request?.transcriptId !== row.transcript_id || state.receipt?.transcriptId !== row.transcript_id || state.request?.operation?.parentContextId !== row.parent_context_id || state.request?.operation?.childContextId !== row.child_context_id || state.request?.operation?.position !== row.position || state.receipt?.revision !== row.revision) throw new Error('Stored transcript append identity does not match');
        return state;
      });
      const items = this.all('SELECT id, body FROM memories WHERE collection_id = ? ORDER BY ordinal', memories.id!).map((row) => {
        const data = parse(row.body);
        if (data.id !== row.id) throw new Error('Stored memory identity does not match');
        return data;
      });
      const applies = this.all('SELECT context_id, position, body FROM memory_applies WHERE memories_id = ? ORDER BY ordinal', memories.id!).map((row) => {
        const state = parse(row.body) as MemoryApplyState;
        if (state.request?.memoriesId !== memories.id || state.receipt?.memoriesId !== memories.id || state.request?.operation?.contextId !== row.context_id || state.request?.operation?.position !== row.position) throw new Error('Stored memory apply identity does not match');
        return state;
      });
      return {
        version: 1,
        transcript: { id: transcript.id as string, revision: transcript.revision as number, starts: parse(transcript.starts), messages: messages.map((row) => parse(row.body)), ...(appends.length ? { appends } : {}) },
        memories: { id: memories.id as string, transcriptId: transcript.id as string, sequence: memories.sequence as number, items, ...(applies.length ? { applies } : {}) },
        active: this.readActiveView(transcript.id as string),
      };
    });
  }

  /** A malformed archive disables observation; only database failure disables required content. */
  loadRecording(conversationId?: string): ObserverStoredRecording {
    return this.transaction(() => {
      if (this.get('PRAGMA foreign_key_check(record_sources)') || this.get('PRAGMA foreign_key_check(records)') || this.get('SELECT 1 FROM record_sources WHERE conversation_id IS NULL LIMIT 1')) throw new Error('Unowned recording source or record');
      const identity = conversationId ?? this.get('SELECT default_id FROM conversation_settings WHERE singleton = 1')?.default_id;
      if (identity === undefined) return { book: { entries: [] }, archives: [] };
      const archives: RecordingArchive[] = this.all('SELECT id, revision, roots, state FROM record_sources WHERE conversation_id = ? ORDER BY rowid', identity).map((row) => ({ sourceId: row.id as string, revision: row.revision as number, rootIds: parse(row.roots), state: row.state as RecordingArchive['state'] }));
      const records = this.all('SELECT id, source_id, kind, body FROM records WHERE source_id IN (SELECT id FROM record_sources WHERE conversation_id = ?) ORDER BY ordinal', identity);
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
        if (archive.revision < roots.length || !Number.isSafeInteger(archive.revision) || !['open', 'sealed', 'incomplete'].includes(archive.state)) throw new Error('Invalid stored recording revision or state');
      }
      return { book: { entries }, archives };
    }, false);
  }

  /** Entity-level restoration validation is part of required content integrity. */
  invalidateContent(cause: unknown): never {
    this.failContent();
    throw new RuntimeError('PERSISTENCE_UNAVAILABLE', '内容恢复失败，请检查服务存储。', undefined, { cause });
  }

  /** Initial identities are generated by the entities and installed together before any runtime binds. */
  initialize(content: { transcript: TranscriptState; memories: MemoriesState; active?: ActiveViewState }): ConversationDescriptor {
    if (this.list().conversations.length) throw new Error('Observer content is already initialized');
    return this.createConversation(content);
  }

  createConversation(content: { transcript: TranscriptState; memories: MemoriesState; active?: ActiveViewState }): ConversationDescriptor {
    this.requireContent();
    return this.transaction(() => {
      const transcript = content.transcript;
      const memories = content.memories;
      if (memories.transcriptId !== transcript.id) throw new Error('Memory source does not match transcript');
      this.run('INSERT INTO transcripts(id, revision, starts) VALUES (?, ?, ?)', transcript.id, transcript.revision, encode(transcript.starts));
      for (const [index, message] of transcript.messages.entries()) this.run('INSERT INTO messages(transcript_id, position, body) VALUES (?, ?, ?)', transcript.id, index, encode(message));
      for (const append of transcript.appends ?? []) this.saveTranscriptAppend(append, transcript.id);
      this.run('INSERT INTO memory_sets(id, transcript_id, sequence) VALUES (?, ?, ?)', memories.id, transcript.id, memories.sequence);
      for (const memory of memories.items) this.run('INSERT INTO memories(id, collection_id, body) VALUES (?, ?, ?)', memory.id, memories.id, encode(memory));
      for (const apply of memories.applies ?? []) this.saveMemoryApply(apply, memories.id);
      const active = freezeActiveView(
        content.active ??
          initialActiveView(
            transcript.id,
            memories.id,
            transcript.starts.at(-1)!,
            transcript.messages.length,
            memories.items.map((memory) => memory.id),
          ),
      );
      if (active.transcriptId !== transcript.id || active.memoriesId !== memories.id || active.messageIndexes.some((index) => index >= transcript.messages.length) || active.memoryIds.some((id) => !memories.items.some((memory) => memory.id === id))) throw new Error('Initial active content does not match its source');
      this.run('INSERT INTO active_content(transcript_id, memories_id, revision, body) VALUES (?, ?, ?, ?)', transcript.id, memories.id, active.revision, encode(active));
      const id = randomUUID();
      const now = Date.now();
      const title = conversationTitle(transcript.messages);
      this.run('INSERT INTO conversations(id, title, transcript_id, memories_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, title, transcript.id, memories.id, now, now);
      this.run('INSERT OR IGNORE INTO conversation_settings(singleton, default_id) VALUES (1, ?)', id);
      return Object.freeze({ id, title, transcriptId: transcript.id, createdAt: now, updatedAt: now });
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
        this.saveActiveView(
          appendActiveView(
            this.readActiveView(change.transcriptId),
            change.messages.map((_, offset) => change.start + offset),
            [],
          ),
        );
        if (change.fixed) {
          if (change.fixed.receipt.start !== change.start || change.fixed.receipt.count !== change.messages.length || change.fixed.receipt.revision !== change.revision || !isEqual(change.fixed.request.messages, change.messages)) throw new Error('Fixed append receipt does not match committed messages');
          this.saveTranscriptAppend(change.fixed, change.transcriptId);
        }
      } else {
        if (change.start <= starts.at(-1)! || change.start >= length) throw new Error('Transcript segment boundary does not match');
        starts.push(change.start);
      }
      this.run('UPDATE transcripts SET revision = ?, starts = ? WHERE id = ?', change.revision, encode(starts), change.transcriptId);
      const first = this.get("SELECT body FROM messages WHERE transcript_id = ? AND json_extract(body, '$.role') = 'user' ORDER BY position LIMIT 1", change.transcriptId);
      this.run('UPDATE conversations SET title = ?, updated_at = ? WHERE transcript_id = ?', first ? conversationTitle([parse(first.body)]) : '新对话', Date.now(), change.transcriptId);
    });
  }

  private saveTranscriptAppend(state: TranscriptAppendState, transcriptId: string): void {
    if (state.request.transcriptId !== transcriptId || state.receipt.transcriptId !== transcriptId) throw new Error('Fixed append belongs to another transcript');
    const operation = state.request.operation;
    this.run('INSERT INTO transcript_appends(transcript_id, parent_context_id, child_context_id, position, revision, body) VALUES (?, ?, ?, ?, ?, ?)', transcriptId, operation.parentContextId, operation.childContextId, operation.position, state.receipt.revision, encode(state));
  }

  private commitMemories(change: MemoriesCommit): undefined {
    this.requireContent();
    this.transaction(() => {
      const row = this.get('SELECT transcript_id, sequence FROM memory_sets WHERE id = ?', change.memoriesId);
      if (!row || row.transcript_id !== change.transcriptId || row.sequence !== change.expectedSequence || change.sequence !== change.expectedSequence + change.upserts.length || (!change.upserts.length && !change.fixed)) throw new Error('Memory sequence does not match saved state');
      const ids = new Set<string>();
      const created: string[] = [];
      for (const memory of change.upserts) {
        if (ids.has(memory.id)) throw new Error('Duplicate memory mutation');
        ids.add(memory.id);
        const previous = this.get('SELECT collection_id FROM memories WHERE id = ?', memory.id);
        if (previous && previous.collection_id !== change.memoriesId) throw new Error('Memory belongs to another collection');
        if (!previous) created.push(memory.id);
        this.run('INSERT INTO memories(id, collection_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', memory.id, change.memoriesId, encode(memory));
      }
      this.run('UPDATE memory_sets SET sequence = ? WHERE id = ?', change.sequence, change.memoriesId);
      if (created.length) this.saveActiveView(appendActiveView(this.readActiveView(change.transcriptId), [], created));
      if (change.fixed) {
        if (
          change.fixed.receipt.startSequence !== change.expectedSequence ||
          change.fixed.receipt.sequence !== change.sequence ||
          !isEqual(
            change.fixed.receipt.memoryIds,
            change.upserts.map((memory) => memory.id),
          )
        )
          throw new Error('Fixed memory receipt does not match committed batch');
        this.saveMemoryApply(change.fixed, change.memoriesId);
      }
      this.run('UPDATE conversations SET updated_at = ? WHERE memories_id = ?', Date.now(), change.memoriesId);
    });
  }

  private saveMemoryApply(state: MemoryApplyState, memoriesId: string): void {
    if (state.request.memoriesId !== memoriesId || state.receipt.memoriesId !== memoriesId) throw new Error('Fixed memory collection does not match');
    this.run('INSERT INTO memory_applies(memories_id, context_id, position, body) VALUES (?, ?, ?, ?)', memoriesId, state.request.operation.contextId, state.request.operation.position, encode(state));
  }

  private readActiveView(transcriptId: string): ActiveViewState {
    const row = this.get('SELECT memories_id, revision, body FROM active_content WHERE transcript_id = ?', transcriptId);
    if (!row) throw new Error('Active content index is missing');
    const state = freezeActiveView(parse(row.body));
    if (state.transcriptId !== transcriptId || state.memoriesId !== row.memories_id || state.revision !== row.revision) throw new Error('Active content identity or revision does not match');
    return state;
  }

  private saveActiveView(state: ActiveViewState): void {
    this.run('UPDATE active_content SET revision = ?, body = ? WHERE transcript_id = ? AND memories_id = ?', state.revision, encode(state), state.transcriptId, state.memoriesId);
  }

  private commitActiveView(change: Parameters<ActiveViewPersistence['commit']>[0]): undefined {
    this.requireContent();
    this.transaction(() => {
      const state = freezeActiveView(change.state);
      const basis = change.basis;
      const previous = this.readActiveView(state.transcriptId);
      const transcript = this.get('SELECT revision FROM transcripts WHERE id = ?', state.transcriptId);
      const memories = this.get('SELECT sequence FROM memory_sets WHERE id = ? AND transcript_id = ?', state.memoriesId, state.transcriptId);
      if (previous.memoriesId !== state.memoriesId || basis.transcriptId !== state.transcriptId || basis.memoriesId !== state.memoriesId || previous.revision !== basis.indexRevision || state.revision !== previous.revision + 1 || transcript?.revision !== basis.transcriptRevision || memories?.sequence !== basis.memorySequence) throw new Error('Active content basis changed');
      for (const index of state.messageIndexes) if (!this.get('SELECT 1 FROM messages WHERE transcript_id = ? AND position = ?', state.transcriptId, index)) throw new Error('Active message does not exist');
      for (const id of state.memoryIds) if (!this.get('SELECT 1 FROM memories WHERE collection_id = ? AND id = ?', state.memoriesId, id)) throw new Error('Active memory does not exist');
      this.saveActiveView(state);
    });
  }

  private readFileCreation(operation: FileCreationState['request']['operation']): FileCreationState | undefined {
    this.requireContent();
    return this.transaction(() => {
      const row = this.get('SELECT body FROM file_creations WHERE context_id = ? AND position = ?', operation.contextId, operation.position);
      return row ? parse(row.body) : undefined;
    });
  }

  private createFileCreation(state: FileCreationState): undefined {
    this.requireContent();
    this.transaction(() => {
      if (state.receipt) throw new Error('File creation must start without a receipt');
      this.run('INSERT INTO file_creations(context_id, position, body) VALUES (?, ?, ?)', state.request.operation.contextId, state.request.operation.position, encode(state));
    });
  }

  private completeFileCreation(state: FileCreationState): undefined {
    this.requireContent();
    this.transaction(() => {
      const row = this.get('SELECT body FROM file_creations WHERE context_id = ? AND position = ?', state.request.operation.contextId, state.request.operation.position);
      const previous: FileCreationState | undefined = row ? parse(row.body) : undefined;
      if (!previous || !isEqual(previous.request, state.request) || !state.receipt || (previous.receipt && !isEqual(previous.receipt, state.receipt))) throw new Error('File creation completion does not match fixed request');
      this.run('UPDATE file_creations SET body = ? WHERE context_id = ? AND position = ?', encode(state), state.request.operation.contextId, state.request.operation.position);
    });
  }

  private createInteraction(state: InteractionState): undefined {
    this.requireContent();
    this.transaction(() => {
      const body = encodeInteraction(state);
      if (state.revision !== 0 || state.delivery !== 'prepared' || state.feedback !== undefined || state.failure !== undefined) throw new Error('Interaction creation must save a prepared request');
      const inserted = this.#database.prepare('INSERT INTO interactions(id, contract, revision, request, body) VALUES (?, ?, ?, ?, ?)').run(state.id, state.contract, state.revision, JSON.stringify(state.request), body);
      if (Number(inserted.changes) !== 1) throw new Error('Interaction request was not saved');
    });
  }

  private commitInteraction(change: InteractionCommit): undefined {
    this.requireContent();
    this.transaction(() => {
      const state = change.state;
      const body = encodeInteraction(state);
      const row = this.get('SELECT id, contract, revision, request, body FROM interactions WHERE id = ?', state.id);
      if (!row || row.revision !== change.expectedRevision || state.revision !== change.expectedRevision + 1) throw new Error('Interaction revision does not match saved state');
      const previous = interactionState(row);
      if (previous.contract !== state.contract || !isEqual(previous.request, state.request)) throw new Error('Interaction identity and request cannot change');
      if (state.delivery !== 'started' || (previous.delivery === 'prepared' && (state.feedback !== undefined || state.failure !== undefined))) throw new Error('Interaction delivery must be started before feedback');
      if (previous.feedback !== undefined && !isEqual(previous.feedback, state.feedback)) throw new Error('Stored interaction feedback cannot be replaced');
      if (previous.failure !== undefined && !isEqual(previous.failure, state.failure)) throw new Error('Stored interaction failure cannot be replaced');
      // BEGIN IMMEDIATE makes the read/check/write one local commit; the predicate retains the expected revision explicitly.
      const updated = this.#database.prepare('UPDATE interactions SET revision = ?, body = ? WHERE id = ? AND revision = ?').run(state.revision, body, state.id, change.expectedRevision);
      if (Number(updated.changes) !== 1) throw new Error('Interaction revision was not committed');
    });
  }

  private readInteraction(id: string): InteractionState | undefined {
    this.requireContent();
    return this.transaction(() => {
      const row = this.get('SELECT id, contract, revision, request, body FROM interactions WHERE id = ?', id);
      return row ? interactionState(row) : undefined;
    });
  }

  openRecording(sourceId: string, conversationId?: string): void {
    if (this.#activeSources.has(sourceId)) throw new Error('This recording source already has a writer');
    this.transaction(() => {
      const identity = conversationId ?? this.get('SELECT default_id FROM conversation_settings WHERE singleton = 1')?.default_id;
      if (identity === undefined || !this.get('SELECT 1 FROM conversations WHERE id = ?', identity)) throw new Error('Content must be initialized before recording');
      this.run("INSERT INTO record_sources(id, revision, roots, state, conversation_id) VALUES (?, 0, '[]', 'open', ?)", sourceId, identity);
    });
    this.#activeSources.add(sourceId);
  }

  applyRecordChange(event: RecordChangeEvent): void {
    if (!this.#activeSources.has(event.recorderId) || this.#failedSources.has(event.recorderId)) throw new Error('Recording source is not writable');
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
      if (!row || row.state !== 'open' || row.revision !== revision || !this.#activeSources.has(sourceId)) throw new Error('Cannot seal an unconfirmed recording source');
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

function descriptor(row: Row): ConversationDescriptor {
  return Object.freeze({ id: row.id as string, title: row.title as string, transcriptId: row.transcript_id as string, createdAt: row.created_at as number, updatedAt: row.updated_at as number });
}

function encode(value: unknown): string {
  return JSON.stringify(snapshotValue(value));
}

function parse(value: unknown): any {
  if (typeof value !== 'string') throw new TypeError('Stored body must be JSON text');
  return JSON.parse(value);
}

function encodeInteraction(state: InteractionState): string {
  if (typeof state.id !== 'string' || !state.id || typeof state.contract !== 'string' || !state.contract || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('Invalid interaction identity or revision');
  const body = JSON.stringify(state);
  if (!isEqual(JSON.parse(body), state)) throw new Error('Interaction state must contain only JSON data');
  return body;
}

function interactionState(row: Row): InteractionState {
  const state = parse(row.body) as InteractionState;
  if (state.id !== row.id || state.contract !== row.contract || state.revision !== row.revision || !isEqual(state.request, parse(row.request))) throw new Error('Stored interaction identity does not match');
  return state;
}

function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number') return false;
  return new Set([1, 5, 6, 7, 8, 10, 11, 13, 14, 15, 17, 21, 26]).has(error.errcode & 255);
}
