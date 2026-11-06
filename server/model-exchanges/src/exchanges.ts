import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RuntimeError } from '@capix/contracts';
import { PersistenceError } from '@capix/diagnostics';
import { publishFact, type ChangeCapture, type EventConsumer } from '@capix/changes';
import { requireModelReply, requireToolFeedback, requireToolResult, type ModelReply, type ToolFeedback, type ToolResult } from '@capix/model-provider';
import type { ExchangeOperation, ExchangeReference, ModelExchangeChange, ModelExchangeEntry, ModelExchangesCommit, ModelExchangesPersistence, ModelExchangesState } from './types.js';
import { canonical, capture, captureSnapshotEnvelope, counter, encodedBytes, identity, record, requireExchangeOperation, requireExchangeReference } from './value.js';
import { defaultModelExchangeLimits, maximumModelExchangeLimits, maximumModelExchangeEntryBytes } from './limits.js';

export interface ModelExchangesOptions {
  readonly persistence?: ModelExchangesPersistence;
  readonly changes?: ChangeCapture<ModelExchangeChange>;
  readonly observation?: EventConsumer<ModelExchangeChange>;
  readonly limits?: { readonly entries?: number; readonly bytes?: number };
}

/** Persistent protocol exchanges. Invocation state and authorization stay outside. */
export class ModelExchanges {
  #id: string = randomUUID();
  #sequence = 0;
  #bytes = 0;
  #mutating = false;
  #persistenceFailure?: PersistenceError;
  readonly #entries = new Map<string, ModelExchangeEntry>();
  readonly #operations = new Map<string, { readonly id: string; readonly callId?: string }>();
  readonly #entryLimit: number;
  readonly #byteLimit: number;
  readonly #persistence?: ModelExchangesPersistence;
  readonly #changes?: ChangeCapture<ModelExchangeChange>;
  readonly #observation?: EventConsumer<ModelExchangeChange>;

  constructor(options: ModelExchangesOptions = {}) {
    this.#entryLimit = limit(options.limits?.entries ?? defaultModelExchangeLimits.entries, maximumModelExchangeLimits.entries, 'entries');
    this.#byteLimit = limit(options.limits?.bytes ?? defaultModelExchangeLimits.bytes, maximumModelExchangeLimits.bytes, 'bytes');
    this.#persistence = options.persistence;
    this.#changes = options.changes;
    this.#observation = options.observation;
  }

  get id(): string {
    return this.#id;
  }
  get sequence(): number {
    return this.#sequence;
  }

  intake(scope: string, operation: ExchangeOperation, reply: ModelReply): ExchangeReference {
    return this.mutate(() => {
      scope = identity(scope);
      operation = requireExchangeOperation(operation);
      reply = requireModelReply(capture(reply));
      const key = canonical(operation);
      const previous = this.#operations.get(key);
      if (previous) {
        const entry = this.#entries.get(previous.id)!;
        if (previous.callId !== undefined || entry.scope !== scope || !isDeepStrictEqual(entry.reply, reply)) throw conflict('Intake differs from its fixed operation');
        return this.reference(entry);
      }
      const sequence = this.nextSequence();
      const entry: ModelExchangeEntry = Object.freeze({ id: randomUUID(), scope, revision: 0, sequence, operation, reply, feedback: Object.freeze([]), receptions: Object.freeze([]) });
      this.install(entry, null, sequence, { key, id: entry.id });
      return this.reference(entry);
    });
  }

  /** New writes need an exact revision. A confirmed effect may use its earlier reference. */
  complete(scope: string, reference: ExchangeReference, toolCallId: string, result: ToolResult, operation?: ExchangeOperation): ExchangeReference {
    return this.mutate(() => {
      const previous = this.read(scope, reference, false);
      toolCallId = identity(toolCallId);
      result = requireToolResult(capture(result));
      operation = operation === undefined ? undefined : requireExchangeOperation(operation);
      if (!previous.reply.output.some((item) => item.kind === 'tool-call' && item.id === toolCallId)) throw conflict('Unknown tool feedback slot');
      const feedback = requireToolFeedback(capture({ toolCallId, ...result }));
      const existing = previous.feedback.find((item) => item.toolCallId === toolCallId);
      if (existing) {
        const original = previous.receptions.find((item) => item.callId === toolCallId)?.operation;
        if (!isDeepStrictEqual(existing, feedback) || !isDeepStrictEqual(original, operation)) throw conflict('Feedback differs from its fixed slot');
        return this.reference(previous);
      }
      // Confirmation precedes the current-revision requirement; it never permits a new stale write.
      this.read(scope, reference);
      const key = operation === undefined ? undefined : canonical(operation);
      if (key && this.#operations.has(key)) throw conflict('Feedback operation already belongs to another effect');
      const sequence = this.nextSequence();
      const next: ModelExchangeEntry = Object.freeze({ ...previous, revision: previous.revision + 1, feedback: Object.freeze([...previous.feedback, feedback]), receptions: operation ? Object.freeze([...previous.receptions, Object.freeze({ callId: toolCallId, operation })]) : previous.receptions });
      this.install(next, previous, sequence, key ? { key, id: next.id, callId: toolCallId } : undefined, toolCallId);
      return this.reference(next);
    });
  }

  read(scope: string, value: ExchangeReference, exact = true): ModelExchangeEntry {
    scope = identity(scope);
    const reference = requireExchangeReference(value);
    const entry = this.#entries.get(reference.id);
    if (reference.collection !== this.id || !entry || entry.scope !== scope || reference.revision > entry.revision || (exact && reference.revision !== entry.revision)) throw conflict('Exchange reference scope or revision mismatch');
    return entry;
  }

  closed(scope: string, references: readonly ExchangeReference[]): readonly ModelExchangeEntry[] {
    if (!Array.isArray(references) || references.length > this.#entryLimit) throw new TypeError('Invalid exchange reference list');
    const accepted = capture(references);
    if (!Array.isArray(accepted)) throw new TypeError('Invalid exchange reference list');
    const seen = new Set<string>();
    return Object.freeze(
      accepted.map((reference) => {
        const entry = this.read(scope, requireExchangeReference(reference));
        if (seen.has(entry.id)) throw conflict('Duplicate exchange reference');
        seen.add(entry.id);
        if (entry.reply.output.filter((item) => item.kind === 'tool-call').length !== entry.feedback.length) throw conflict('Exchange is missing tool feedback');
        return entry;
      }),
    );
  }

  /** Creation order is stable; this does not infer a cross-invocation causal order. */
  values(scope?: string): readonly ModelExchangeEntry[] {
    if (scope !== undefined) identity(scope);
    return Object.freeze([...this.#entries.values()].filter((entry) => scope === undefined || entry.scope === scope));
  }

  get(id: string): ModelExchangeEntry | undefined {
    return this.#entries.get(identity(id));
  }

  reference(entry: ModelExchangeEntry): ExchangeReference {
    const current = this.#entries.get(entry.id);
    if (current !== entry) throw conflict('Exchange entry is not the current entity value');
    return Object.freeze({ collection: this.id, id: entry.id, revision: entry.revision });
  }

  snapshot(): ModelExchangesState {
    return Object.freeze({ formatVersion: 1, id: this.id, sequence: this.sequence, entries: this.values() });
  }

  /** Validate the whole snapshot before publishing any restored entity. No commits or events. */
  static restore(value: unknown, options: ModelExchangesOptions = {}): ModelExchanges {
    const entity = new ModelExchanges(options);
    const saved = captureSnapshotEnvelope(value, entity.#entryLimit);
    if (saved.formatVersion !== 1) throw new TypeError('Unsupported model exchange snapshot');
    entity.#id = identity(saved.id);
    entity.#sequence = counter(saved.sequence);
    let previousCreated = 0;
    let changes = 0;
    for (const value of saved.entries) {
      const entry = requireModelExchangeEntry(value);
      if (entity.#entries.has(entry.id) || entry.sequence <= previousCreated || entry.sequence > changes + 1 || entry.sequence + entry.revision > entity.sequence) throw new TypeError('Invalid saved model exchange order');
      previousCreated = entry.sequence;
      changes += 1 + entry.revision;
      entity.#bytes += encodedBytes(entry);
      if (entity.#entries.size >= entity.#entryLimit || entity.#bytes > entity.#byteLimit) throw new RangeError('Model exchange snapshot exceeds collection limits');
      for (const [operation, callId] of [[entry.operation, undefined], ...entry.receptions.map((item) => [item.operation, item.callId] as const)] as const) {
        const key = canonical(operation);
        if (entity.#operations.has(key)) throw new TypeError('Duplicate saved model exchange operation');
        entity.#operations.set(key, { id: entry.id, ...(callId === undefined ? {} : { callId }) });
      }
      entity.#entries.set(entry.id, entry);
    }
    if (changes !== entity.sequence) throw new TypeError('Model exchange sequence does not match its changes');
    return entity;
  }

  private mutate<Value>(action: () => Value): Value {
    if (this.#persistenceFailure) throw this.#persistenceFailure;
    if (this.#mutating) throw new Error('Model exchange persistence or publication cannot reenter mutation');
    this.#mutating = true;
    try {
      return action();
    } finally {
      this.#mutating = false;
    }
  }

  private nextSequence(): number {
    if (!Number.isSafeInteger(this.#sequence + 1)) throw new RangeError('Model exchange sequence is exhausted');
    return this.#sequence + 1;
  }

  private install(entry: ModelExchangeEntry, previous: ModelExchangeEntry | null, sequence: number, operation?: { key: string; id: string; callId?: string }, toolCallId?: string): void {
    const size = encodedBytes(entry);
    const bytes = this.#bytes + size - (previous ? encodedBytes(previous) : 0);
    if (size > maximumModelExchangeEntryBytes || bytes > this.#byteLimit || (!previous && this.#entries.size >= this.#entryLimit)) throw new RangeError('Model exchange collection exceeds capacity');
    const change: ModelExchangesCommit = Object.freeze({ collection: this.id, expectedSequence: this.sequence, sequence, previous, entry });
    try {
      const result: unknown = this.#persistence?.commit(change);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError('Model exchange persistence must return undefined synchronously');
      }
    } catch (cause) {
      this.#persistenceFailure = cause instanceof PersistenceError ? cause : new PersistenceError('model-exchanges.commit', cause);
      throw this.#persistenceFailure;
    }
    this.#entries.set(entry.id, entry);
    this.#bytes = bytes;
    this.#sequence = sequence;
    if (operation) this.#operations.set(operation.key, { id: operation.id, ...(operation.callId === undefined ? {} : { callId: operation.callId }) });
    const event: ModelExchangeChange = Object.freeze({ type: 'model-exchange', collection: this.id, sequence, reference: this.reference(entry), scope: entry.scope, kind: previous ? 'feedback' : 'intake', ...(toolCallId === undefined ? {} : { toolCallId }) });
    publishFact(event, this.#changes, this.#observation);
  }
}

export function requireModelExchangeEntry(value: unknown): ModelExchangeEntry {
  const item = record(capture(value), ['id', 'scope', 'revision', 'sequence', 'operation', 'reply', 'feedback', 'receptions']);
  if (!Array.isArray(item.feedback) || !Array.isArray(item.receptions)) throw new TypeError('Invalid saved exchange feedback');
  const reply = requireModelReply(item.reply);
  const feedback: readonly ToolFeedback[] = Object.freeze(item.feedback.map(requireToolFeedback));
  const calls = new Set(reply.output.filter((entry) => entry.kind === 'tool-call').map((entry) => entry.id));
  const completed = new Set(feedback.map((entry) => entry.toolCallId));
  if (completed.size !== feedback.length || feedback.some((entry) => !calls.has(entry.toolCallId)) || item.revision !== feedback.length) throw new TypeError('Invalid saved exchange slots');
  const receptions = Object.freeze(
    item.receptions.map((value) => {
      const entry = record(value, ['callId', 'operation']);
      const callId = identity(entry.callId);
      if (!completed.has(callId)) throw new TypeError('Saved feedback operation has no corresponding slot');
      return Object.freeze({ callId, operation: requireExchangeOperation(entry.operation) });
    }),
  );
  if (new Set(receptions.map((item) => item.callId)).size !== receptions.length) throw new TypeError('Duplicate saved feedback operation');
  const sequence = counter(item.sequence);
  if (sequence === 0) throw new TypeError('Exchange creation sequence must be positive');
  return Object.freeze({ id: identity(item.id), scope: identity(item.scope), revision: counter(item.revision), sequence, operation: requireExchangeOperation(item.operation), reply, feedback, receptions });
}

function limit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid model exchange ${name} limit`);
  return value;
}
function conflict(message: string): RuntimeError {
  return new RuntimeError('MODEL_EXCHANGE_CONFLICT', message);
}
