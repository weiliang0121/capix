import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ModelExchanges, maximumModelExchangeLimits, maximumModelExchangeEntryBytes, requireModelExchangeEntry, type ModelExchangeEntry, type ExchangeOperation, type ModelExchangesCommit, type ModelExchangesPersistence, type ModelExchangesState } from '@weiliang0121/capix-model-exchanges';
import { z } from 'zod';
import { cloneCheckpointValue } from '@weiliang0121/capix-checkpoint';
import type { JsonObject } from '@weiliang0121/capix-model-provider';
import { RecoveryConflict, requireIdentity, requireRevision, type RecoveryTransaction } from './recovery.js';

export interface ExchangeArchiveMetadata {
  readonly source: { readonly transcriptId: string; readonly index: number };
  readonly scope: string;
  readonly policy: JsonObject;
  readonly limits: { readonly entries: number; readonly bytes: number };
}
export interface ExchangeArchiveSummary {
  readonly id: string;
  readonly sequence: number;
  readonly entries: number;
  readonly bytes: number;
  readonly metadata: ExchangeArchiveMetadata;
}
export interface LoadedExchangeArchive {
  readonly state: ModelExchangesState;
  readonly metadata: ExchangeArchiveMetadata;
}
export interface ExchangeArchivePage {
  readonly items: readonly ExchangeArchiveSummary[];
  readonly next?: string;
}
export interface ConversationExchanges extends ModelExchangesPersistence {
  load(collection: string): LoadedExchangeArchive | undefined;
  list(options?: { readonly after?: string; readonly limit?: number }): ExchangeArchivePage;
  /** Idempotent only while the exact prepared collection is still empty. */
  initialize(empty: ModelExchangesState, metadata: ExchangeArchiveMetadata): void;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerSchema = z.strictObject({ id: z.string().min(1), sequence: count, bytes: count.max(maximumModelExchangeLimits.bytes), entry_count: count.max(maximumModelExchangeLimits.entries), metadata: z.string() });
const rowSchema = z.strictObject({ collection: z.string().min(1), id: z.string().min(1), ordinal: count, revision: count, body: z.string() });
const operationRow = z.strictObject({ operation: z.string(), exchange_id: z.string(), call_id: z.string().nullable() });
const metadataSchema = z.strictObject({ source: z.strictObject({ transcriptId: z.string().min(1), index: count }), scope: z.string().trim().min(1), policy: z.record(z.string(), z.json()), limits: z.strictObject({ entries: count.positive().max(maximumModelExchangeLimits.entries), bytes: count.positive().max(maximumModelExchangeLimits.bytes) }) });

/** Independent collections, each with fixed metadata, exact effects and its own CAS sequence. */
export class SqliteExchanges implements ConversationExchanges {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: RecoveryTransaction,
  ) {}

  load(collection: string): LoadedExchangeArchive | undefined {
    requireIdentity(collection);
    return this.transaction('model-exchanges.load', () => {
      const row = this.database.prepare('SELECT * FROM model_exchanges WHERE id = ?').get(collection);
      if (!row) {
        this.requireNoOrphans(collection);
        return undefined;
      }
      const saved = this.summary(row);
      const sizes = this.database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM model_exchange_entries WHERE collection = ?').get(collection);
      if (sizes?.count !== saved.entries || sizes?.bytes !== saved.bytes) throw new Error('Model exchange row sizes differ from collection limits');
      const entries = this.database
        .prepare('SELECT * FROM model_exchange_entries WHERE collection = ? ORDER BY ordinal')
        .all(collection)
        .map((row) => this.entry(row, collection));
      if (entries.some((entry) => entry.scope !== saved.metadata.scope)) throw new Error('Saved model exchange scope differs from its archive metadata');
      if (entries.reduce((sum, entry) => sum + bytes(entry), 0) !== saved.bytes) throw new Error('Model exchange byte accounting differs from saved entries');
      const state = ModelExchanges.restore({ formatVersion: 1, id: saved.id, sequence: saved.sequence, entries }, { limits: saved.metadata.limits }).snapshot();
      const expected = entries.flatMap(effectRows).sort((a, b) => a.operation.localeCompare(b.operation));
      const actual = this.database
        .prepare('SELECT operation, exchange_id, call_id FROM model_exchange_operations WHERE collection = ?')
        .all(collection)
        .map((row) => operationRow.parse(row))
        .sort((a, b) => a.operation.localeCompare(b.operation));
      if (!isDeepStrictEqual(actual, expected)) throw new Error('Model exchange effect index differs from its source facts');
      return Object.freeze({ state, metadata: saved.metadata });
    });
  }

  list(options: { readonly after?: string; readonly limit?: number } = {}): ExchangeArchivePage {
    if (options.after !== undefined) requireIdentity(options.after);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Archive page limit must be between 1 and 200');
    return this.transaction('model-exchanges.list', () => {
      const rows = options.after === undefined ? this.database.prepare('SELECT * FROM model_exchanges ORDER BY id LIMIT ?').all(limit + 1) : this.database.prepare('SELECT * FROM model_exchanges WHERE id > ? ORDER BY id LIMIT ?').all(options.after, limit + 1);
      const items = Object.freeze(rows.slice(0, limit).map((row) => this.summary(row)));
      return Object.freeze({ items, ...(rows.length > limit ? { next: items.at(-1)!.id } : {}) });
    });
  }

  initialize(empty: ModelExchangesState, metadata: ExchangeArchiveMetadata): void {
    const fixed = captureMetadata(metadata);
    const accepted = ModelExchanges.restore(empty, { limits: fixed.limits }).snapshot();
    if (accepted.sequence !== 0 || accepted.entries.length !== 0) throw new TypeError('Prepared model exchange collection must be empty');
    this.transaction('model-exchanges.initialize', () => {
      const content = this.database.prepare('SELECT transcript_id FROM content').get();
      if (!content || content.transcript_id !== fixed.source.transcriptId) throw conflict('Model exchange source must belong to the initialized conversation');
      const existing = this.database.prepare('SELECT * FROM model_exchanges WHERE id = ?').get(accepted.id);
      if (existing) {
        const saved = this.summary(existing);
        if (!isDeepStrictEqual(saved.metadata, fixed) || saved.sequence !== 0 || saved.entries !== 0 || saved.bytes !== 0) throw conflict('Prepared model exchange identity, metadata or empty state differs');
        this.requireNoOrphans(accepted.id);
        return;
      }
      this.requireNoOrphans(accepted.id);
      this.database.prepare('INSERT INTO model_exchanges VALUES (?, 0, 0, 0, ?)').run(accepted.id, JSON.stringify(fixed));
    });
  }

  commit(change: ModelExchangesCommit): undefined {
    requireIdentity(change.collection);
    requireRevision(change.expectedSequence);
    if (change.sequence !== change.expectedSequence + 1) throw new TypeError('Model exchange commit must advance one change');
    const entry = requireModelExchangeEntry(change.entry);
    const previous = change.previous === null ? null : requireModelExchangeEntry(change.previous);
    const collection = change.collection;
    const expectedSequence = change.expectedSequence;
    const sequence = change.sequence;
    if (previous ? !validAppend(previous, entry) : entry.revision !== 0 || entry.sequence !== sequence) throw new TypeError('Invalid model exchange transition');
    this.transaction('model-exchanges.commit', () => {
      const row = this.database.prepare('SELECT * FROM model_exchanges WHERE id = ?').get(collection);
      const saved = row ? this.summary(row) : undefined;
      if (!saved || saved.sequence !== expectedSequence) throw conflict('Model exchange collection sequence or identity differs');
      if (entry.scope !== saved.metadata.scope) throw conflict('Model exchange scope differs from its fixed archive metadata');
      const currentRow = this.database.prepare('SELECT * FROM model_exchange_entries WHERE collection = ? AND id = ?').get(collection, entry.id);
      const current = currentRow ? this.entry(currentRow, collection) : null;
      if (!isDeepStrictEqual(current, previous)) throw conflict('Model exchange previous entry differs');
      const nextBytes = saved.bytes + bytes(entry) - (previous ? bytes(previous) : 0);
      if (nextBytes > saved.metadata.limits.bytes) throw conflict('Model exchange collection exceeds its fixed budget');
      if (!previous && saved.entries >= saved.metadata.limits.entries) throw conflict('Model exchange collection exceeds its fixed entry budget');
      const effects = effectRows(entry).slice(previous ? effectRows(previous).length : 0);
      for (const effect of effects) if (this.database.prepare('SELECT 1 FROM model_exchange_operations WHERE collection = ? AND operation = ?').get(collection, effect.operation)) throw conflict('Model exchange operation is already fixed');
      if (previous) this.database.prepare('UPDATE model_exchange_entries SET revision = ?, body = ? WHERE collection = ? AND id = ?').run(entry.revision, JSON.stringify(entry), collection, entry.id);
      else this.database.prepare('INSERT INTO model_exchange_entries VALUES (?, ?, ?, ?, ?)').run(collection, entry.id, entry.sequence, entry.revision, JSON.stringify(entry));
      for (const effect of effects) this.database.prepare('INSERT INTO model_exchange_operations VALUES (?, ?, ?, ?)').run(collection, effect.operation, effect.exchange_id, effect.call_id);
      const changed = this.database.prepare('UPDATE model_exchanges SET sequence = ?, bytes = ?, entry_count = ? WHERE id = ? AND sequence = ?').run(sequence, nextBytes, saved.entries + (previous ? 0 : 1), collection, expectedSequence);
      if (changed.changes !== 1) throw new Error('Model exchange collection changed during exclusive commit');
    });
    return undefined;
  }

  private requireNoOrphans(collection: string): void {
    if (this.database.prepare('SELECT 1 FROM model_exchange_entries WHERE collection = ? LIMIT 1').get(collection) || this.database.prepare('SELECT 1 FROM model_exchange_operations WHERE collection = ? LIMIT 1').get(collection)) throw new Error('Cannot initialize or report a missing collection with existing entries');
  }

  private summary(value: unknown): ExchangeArchiveSummary {
    const row = headerSchema.parse(value);
    if (Buffer.byteLength(row.metadata) > 64 * 1024) throw new Error('Saved model exchange archive metadata exceeds its size limit');
    const metadata = captureMetadata(JSON.parse(row.metadata));
    if (row.bytes > metadata.limits.bytes || row.entry_count > metadata.limits.entries) throw new Error('Saved model exchange collection exceeds its fixed limits');
    return Object.freeze({ id: row.id, sequence: row.sequence, entries: row.entry_count, bytes: row.bytes, metadata });
  }

  private entry(value: unknown, collection: string): ModelExchangeEntry {
    const row = rowSchema.parse(value);
    if (Buffer.byteLength(row.body) > maximumModelExchangeEntryBytes) throw new Error('Saved model exchange exceeds its size limit');
    const entry = requireModelExchangeEntry(JSON.parse(row.body));
    if (row.collection !== collection || entry.id !== row.id || entry.sequence !== row.ordinal || entry.revision !== row.revision) throw new Error('Model exchange entry differs from its row');
    return entry;
  }
}

function captureMetadata(value: unknown): ExchangeArchiveMetadata {
  const captured = cloneCheckpointValue(value);
  if (Buffer.byteLength(JSON.stringify(captured)) > 64 * 1024) throw new TypeError('Model exchange archive metadata exceeds its size limit');
  const parsed = metadataSchema.parse(captured);
  if (!isDeepStrictEqual(parsed, captured)) throw new TypeError('Model exchange archive metadata must be canonical');
  return freeze(parsed);
}

function freeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validAppend(previous: ModelExchangeEntry, next: ModelExchangeEntry): boolean {
  return previous.id === next.id && previous.scope === next.scope && previous.sequence === next.sequence && next.revision === previous.revision + 1 && isDeepStrictEqual(previous.operation, next.operation) && isDeepStrictEqual(previous.reply, next.reply) && next.feedback.length === previous.feedback.length + 1 && isDeepStrictEqual(previous.feedback, next.feedback.slice(0, -1)) && next.receptions.length >= previous.receptions.length && next.receptions.length <= previous.receptions.length + 1 && isDeepStrictEqual(previous.receptions, next.receptions.slice(0, previous.receptions.length)) && (next.receptions.length === previous.receptions.length || next.receptions.at(-1)!.callId === next.feedback.at(-1)!.toolCallId);
}
function operationKey(operation: ExchangeOperation): string {
  return JSON.stringify([operation.parentContextId, operation.childContextId, operation.position]);
}
function effectRows(entry: ModelExchangeEntry) {
  return [{ operation: operationKey(entry.operation), exchange_id: entry.id, call_id: null as string | null }, ...entry.receptions.map((item) => ({ operation: operationKey(item.operation), exchange_id: entry.id, call_id: item.callId }))];
}
function bytes(entry: ModelExchangeEntry): number {
  return Buffer.byteLength(JSON.stringify(entry));
}
function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('MODEL_EXCHANGE_PERSISTENCE_CONFLICT', message);
}
