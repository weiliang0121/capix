import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { publishFact, type ChangeCapture, type EventConsumer } from '@weiliang0121/capix-changes';
import { requireModelReply, requireModelRequest, requireToolFeedback, requireToolResult, type ModelReply, type ModelRequest, type ToolFeedback, type ToolResult } from '@weiliang0121/capix-model-provider';
import type { ExchangeOperation, ExchangeReference, ExchangeOriginReference, ExchangePrefix, ModelExchangeBasis, ModelExchangeOrigin, ModelExchangeChange, ModelExchangeEntry, ModelExchangesCommit, ModelExchangesPersistence, ModelExchangesState } from './types.js';
import { canonical, capture, captureSnapshotEnvelope, counter, encodedBytes, identity, record, requireExchangeOperation, requireExchangeReference, requireExchangeOriginReference } from './value.js';
import { defaultModelExchangeLimits, maximumModelExchangeLimits, maximumModelExchangeEntryBytes, maximumModelExchangeOriginBytes } from './limits.js';
import { requireModelExchangeBasis, requireModelExchangeOrigin, exchangeOriginDigest } from './origin.js';

export interface ModelExchangesOptions {
  readonly persistence?: ModelExchangesPersistence;
  readonly changes?: ChangeCapture<ModelExchangeChange>;
  readonly observation?: EventConsumer<ModelExchangeChange>;
  readonly limits?: { readonly origins?: number; readonly entries?: number; readonly bytes?: number };
}

/** Persistent protocol exchanges. Invocation state and authorization stay outside. */
export class ModelExchanges {
  #id: string = randomUUID();
  #sequence = 0;
  #bytes = 0;
  #mutating = false;
  #persistenceFailure?: PersistenceError;
  readonly #origins = new Map<string, ModelExchangeOrigin>();
  readonly #originEntries = new Map<string, string[]>();
  readonly #sizes = new Map<string, number>();
  readonly #originLimit: number;
  readonly #entries = new Map<string, ModelExchangeEntry>();
  readonly #operations = new Map<string, { readonly id: string; readonly callId?: string }>();
  readonly #entryLimit: number;
  readonly #byteLimit: number;
  readonly #persistence?: ModelExchangesPersistence;
  readonly #changes?: ChangeCapture<ModelExchangeChange>;
  readonly #observation?: EventConsumer<ModelExchangeChange>;

  constructor(options: ModelExchangesOptions = {}) {
    this.#originLimit = limit(options.limits?.origins ?? defaultModelExchangeLimits.origins, maximumModelExchangeLimits.origins, 'origins');
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

  /** Caller-fixed identity permits confirmation of a prepared origin after restart. */
  begin(id: string, basis: ModelExchangeBasis): ExchangeOriginReference {
    return this.mutate(() => {
      id = identity(id);
      basis = requireModelExchangeBasis(basis);
      const digest = exchangeOriginDigest(basis);
      const previous = this.#origins.get(id);
      if (previous) {
        if (previous.digest !== digest || !isDeepStrictEqual(previous.request, basis.request) || !isDeepStrictEqual(previous.catalog, basis.catalog)) throw conflict('Origin differs from its fixed basis');
        return this.originReference(previous);
      }
      if (this.#entries.has(id)) throw conflict('Origin identity already belongs to an exchange');
      const sequence = this.nextSequence();
      const origin: ModelExchangeOrigin = Object.freeze({ id, sequence, digest, ...basis });
      const size = encodedBytes(origin);
      if (size > maximumModelExchangeOriginBytes || this.#bytes + size > this.#byteLimit || this.#origins.size >= this.#originLimit) throw new RangeError('Model exchange collection exceeds capacity');
      this.persist(Object.freeze({ kind: 'origin', collection: this.id, expectedSequence: this.sequence, sequence, origin }));
      this.#origins.set(id, origin);
      this.#originEntries.set(id, []);
      this.#bytes += size;
      this.#sequence = sequence;
      const reference = this.originReference(origin);
      publishFact(Object.freeze({ type: 'model-exchange', collection: this.id, sequence, origin: id, kind: 'origin', reference }), this.#changes, this.#observation);
      return reference;
    });
  }

  origin(value: ExchangeOriginReference): ModelExchangeOrigin {
    const reference = requireExchangeOriginReference(value);
    const origin = this.#origins.get(reference.id);
    if (reference.collection !== this.id || !origin || origin.digest !== reference.digest) throw conflict('Exchange origin reference mismatch');
    return origin;
  }

  private originReference(origin: ModelExchangeOrigin): ExchangeOriginReference {
    return Object.freeze({ collection: this.id, id: origin.id, digest: origin.digest });
  }

  intake(originReference: ExchangeOriginReference, operation: ExchangeOperation, reply: ModelReply): ExchangeReference {
    return this.mutate(() => {
      const origin = this.origin(originReference);
      operation = requireExchangeOperation(operation);
      reply = requireModelReply(capture(reply));
      const key = canonical(operation);
      const previous = this.#operations.get(key);
      if (previous) {
        const entry = this.#entries.get(previous.id)!;
        if (previous.callId !== undefined || entry.origin !== origin.id || !isDeepStrictEqual(entry.reply, reply)) throw conflict('Intake differs from its fixed operation');
        return this.reference(entry);
      }
      const sequence = this.nextSequence();
      const entry: ModelExchangeEntry = Object.freeze({ id: randomUUID(), origin: origin.id, revision: 0, sequence, operation, reply, feedback: Object.freeze([]), receptions: Object.freeze([]) });
      this.install(entry, null, sequence, { key, id: entry.id });
      return this.reference(entry);
    });
  }

  /** New writes need an exact revision. A confirmed effect may use its earlier reference. */
  complete(originReference: ExchangeOriginReference, reference: ExchangeReference, toolCallId: string, result: ToolResult, operation?: ExchangeOperation): ExchangeReference {
    return this.mutate(() => {
      const previous = this.read(originReference, reference, false);
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
      this.read(originReference, reference);
      const key = operation === undefined ? undefined : canonical(operation);
      if (key && this.#operations.has(key)) throw conflict('Feedback operation already belongs to another effect');
      const sequence = this.nextSequence();
      const next: ModelExchangeEntry = Object.freeze({ ...previous, revision: previous.revision + 1, feedback: Object.freeze([...previous.feedback, feedback]), receptions: operation ? Object.freeze([...previous.receptions, Object.freeze({ callId: toolCallId, operation })]) : previous.receptions });
      this.install(next, previous, sequence, key ? { key, id: next.id, callId: toolCallId } : undefined, toolCallId);
      return this.reference(next);
    });
  }

  read(originReference: ExchangeOriginReference, value: ExchangeReference, exact = true): ModelExchangeEntry {
    const origin = this.origin(originReference);
    const reference = requireExchangeReference(value);
    const entry = this.#entries.get(reference.id);
    if (reference.collection !== this.id || !entry || entry.origin !== origin.id || reference.revision > entry.revision || (exact && reference.revision !== entry.revision)) throw conflict('Exchange reference origin or revision mismatch');
    return entry;
  }

  /** Ordered first K exchanges with complete feedback slots; not permission to continue. */
  closed(originReference: ExchangeOriginReference, references: readonly ExchangeReference[]): readonly ModelExchangeEntry[] {
    const origin = this.origin(originReference);
    if (!Array.isArray(references) || isProxy(references) || references.length > this.#entryLimit) throw new TypeError('Invalid exchange reference list');
    const accepted = capture(references);
    if (!Array.isArray(accepted)) throw new TypeError('Invalid exchange reference list');
    const ordered = this.#originEntries.get(origin.id)!;
    return Object.freeze(
      accepted.map((reference, index) => {
        const entry = this.read(originReference, requireExchangeReference(reference));
        if (entry.id !== ordered[index]) throw conflict('Exchange references are not an origin prefix');
        if (entry.reply.output.filter((item) => item.kind === 'tool-call').length !== entry.feedback.length) throw conflict('Exchange is missing tool feedback');
        return entry;
      }),
    );
  }

  request(value: ExchangePrefix): ModelRequest {
    const prefix = record(capture(value), ['origin', 'exchanges']);
    const reference = requireExchangeOriginReference(prefix.origin);
    const origin = this.origin(reference);
    const entries = this.closed(reference, prefix.exchanges as readonly ExchangeReference[]);
    return Object.freeze(requireModelRequest({ ...origin.request, ...(origin.catalog.tools.length === 0 ? {} : { tools: origin.catalog.tools }), exchanges: Object.freeze(entries.map((entry) => Object.freeze({ reply: entry.reply, feedback: entry.feedback }))) }));
  }

  /** Creation order is stable; this does not infer a cross-invocation causal order. */
  values(originReference?: ExchangeOriginReference): readonly ModelExchangeEntry[] {
    if (originReference === undefined) return Object.freeze([...this.#entries.values()]);
    const origin = this.origin(originReference);
    return Object.freeze(this.#originEntries.get(origin.id)!.map((id) => this.#entries.get(id)!));
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
    return Object.freeze({ formatVersion: 2, id: this.id, sequence: this.sequence, origins: Object.freeze([...this.#origins.values()]), entries: this.values() });
  }

  /** Validate the whole snapshot before publishing any restored entity. No commits or events. */
  static restore(value: unknown, options: ModelExchangesOptions = {}): ModelExchanges {
    const entity = new ModelExchanges(options);
    const saved = captureSnapshotEnvelope(value, entity.#entryLimit, entity.#originLimit);
    if (saved.formatVersion !== 2) throw new TypeError('Unsupported model exchange snapshot');
    entity.#id = identity(saved.id);
    entity.#sequence = counter(saved.sequence);
    const creations: { readonly sequence: number; readonly revisions: number }[] = [];
    let previousOrigin = 0;
    for (const value of saved.origins) {
      const origin = requireModelExchangeOrigin(value);
      if (entity.#origins.has(origin.id) || origin.sequence <= previousOrigin) throw new TypeError('Invalid saved model exchange origin order');
      previousOrigin = origin.sequence;
      entity.#bytes += encodedBytes(origin);
      if (entity.#bytes > entity.#byteLimit) throw new RangeError('Model exchange snapshot exceeds collection limits');
      entity.#origins.set(origin.id, origin);
      entity.#originEntries.set(origin.id, []);
      creations.push({ sequence: origin.sequence, revisions: 0 });
    }
    let previousCreated = 0;
    for (const value of saved.entries) {
      const entry = requireModelExchangeEntry(value);
      const origin = entity.#origins.get(entry.origin);
      if (entity.#entries.has(entry.id) || entity.#origins.has(entry.id) || !origin || origin.sequence >= entry.sequence || entry.sequence <= previousCreated || entry.sequence + entry.revision > entity.sequence) throw new TypeError('Invalid saved model exchange order');
      previousCreated = entry.sequence;
      const size = encodedBytes(entry);
      entity.#bytes += size;
      if (entity.#bytes > entity.#byteLimit) throw new RangeError('Model exchange snapshot exceeds collection limits');
      for (const [operation, callId] of [[entry.operation, undefined], ...entry.receptions.map((item) => [item.operation, item.callId] as const)] as const) {
        const key = canonical(operation);
        if (entity.#operations.has(key)) throw new TypeError('Duplicate saved model exchange operation');
        entity.#operations.set(key, { id: entry.id, ...(callId === undefined ? {} : { callId }) });
      }
      entity.#entries.set(entry.id, entry);
      entity.#sizes.set(entry.id, size);
      entity.#originEntries.get(entry.origin)!.push(entry.id);
      creations.push({ sequence: entry.sequence, revisions: entry.revision });
    }
    // Revisions may fill gaps only after their entry exists; origins contribute one creation.
    // Merging both creation streams preserves that feasibility check across interleaving.
    creations.sort((left, right) => left.sequence - right.sequence);
    let changes = 0;
    let previousCreation = 0;
    for (const creation of creations) {
      if (creation.sequence <= previousCreation || creation.sequence > changes + 1 || creation.sequence > entity.sequence) throw new TypeError('Invalid saved model exchange creation sequence');
      previousCreation = creation.sequence;
      changes += 1 + creation.revisions;
      if (!Number.isSafeInteger(changes)) throw new TypeError('Invalid saved model exchange change count');
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
    const bytes = this.#bytes + size - (previous ? this.#sizes.get(previous.id)! : 0);
    if (size > maximumModelExchangeEntryBytes || bytes > this.#byteLimit || (!previous && this.#entries.size >= this.#entryLimit)) throw new RangeError('Model exchange collection exceeds capacity');
    const change: ModelExchangesCommit = Object.freeze({ kind: 'exchange', collection: this.id, expectedSequence: this.sequence, sequence, previous, entry });
    this.persist(change);
    if (!previous) this.#originEntries.get(entry.origin)!.push(entry.id);
    this.#sizes.set(entry.id, size);
    this.#entries.set(entry.id, entry);
    this.#bytes = bytes;
    this.#sequence = sequence;
    if (operation) this.#operations.set(operation.key, { id: operation.id, ...(operation.callId === undefined ? {} : { callId: operation.callId }) });
    const event: ModelExchangeChange = Object.freeze({ type: 'model-exchange', collection: this.id, sequence, reference: this.reference(entry), origin: entry.origin, kind: previous ? 'feedback' : 'intake', ...(toolCallId === undefined ? {} : { toolCallId }) });
    publishFact(event, this.#changes, this.#observation);
  }
  private persist(change: ModelExchangesCommit): void {
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
  }
}

export function requireModelExchangeEntry(value: unknown): ModelExchangeEntry {
  const item = record(capture(value), ['id', 'origin', 'revision', 'sequence', 'operation', 'reply', 'feedback', 'receptions']);
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
  return Object.freeze({ id: identity(item.id), origin: identity(item.origin), revision: counter(item.revision), sequence, operation: requireExchangeOperation(item.operation), reply, feedback, receptions });
}

function limit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid model exchange ${name} limit`);
  return value;
}
function conflict(message: string): RuntimeError {
  return new RuntimeError('MODEL_EXCHANGE_CONFLICT', message);
}
