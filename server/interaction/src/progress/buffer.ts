import { isPromise } from 'node:util/types';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import { captureInteractionValue, isNonBlankString } from '../value.js';
import { positiveLimit, ProgressBudget } from './budget.js';
import type { InteractionCursor, InteractionProgressFact, InteractionProgressLimits, InteractionProgressRead, InteractionProgressReader, InteractionPublication } from './types.js';

type Item<Delta> = Extract<InteractionProgressRead<Delta>, { kind: 'item' }>;
type Terminal = Extract<InteractionProgressRead<never>, { kind: 'sealed' | 'unavailable' }>;
type Inspection<Delta> = Item<Delta> | Terminal | { readonly kind: 'pending' };

export function validateProgressLimits(limits: InteractionProgressLimits = {}): Required<InteractionProgressLimits> {
  return Object.freeze({
    maxBytes: positiveLimit(limits.maxBytes ?? 4 * 1024 * 1024, 'Progress maxBytes'),
    maxEntries: positiveLimit(limits.maxEntries ?? 16_384, 'Progress maxEntries'),
    maxReaders: positiveLimit(limits.maxReaders ?? 64, 'Progress maxReaders'),
  });
}

function position(interactionId: string, sequence: number): InteractionCursor {
  return Object.freeze({ interactionId, sequence });
}

function checkCursor(interactionId: string, after?: InteractionCursor, head?: number): InteractionCursor {
  if (after !== undefined && (!after || typeof after !== 'object')) throw new RuntimeError('INTERACTION_PROGRESS_CURSOR', 'Progress cursor must be a position in this interaction');
  const sequence = after === undefined ? 0 : after.sequence;
  if ((after !== undefined && after.interactionId !== interactionId) || !Number.isSafeInteger(sequence) || sequence < 0 || (head !== undefined && sequence > head)) throw new RuntimeError('INTERACTION_PROGRESS_CURSOR', 'Progress cursor must refer to an existing position in this interaction');
  return position(interactionId, sequence);
}

/** One complete bounded history. Readers keep positions, never independent payload queues. */
export class InteractionProgress<Delta> {
  readonly #limits: Required<InteractionProgressLimits>;
  readonly #budget: ProgressBudget;
  readonly #decode: (value: unknown) => Delta;
  readonly #observation?: ProgressChannel<InteractionProgressFact>;
  readonly #items: Item<Delta>[] = [];
  readonly #readers = new Set<ProgressReader<Delta>>();
  readonly #waiters = new Set<() => void>();
  #bytes = 0;
  #head = 0;
  #revision = 0;
  #sealed = false;
  #unavailable?: Extract<Terminal, { kind: 'unavailable' }>;
  #publishing = false;
  #observing = false;
  #installed = false;

  constructor(
    readonly interactionId: string,
    decode: (value: unknown) => Delta,
    limits: InteractionProgressLimits = {},
    budget = new ProgressBudget(),
    observation?: ProgressReceiver<InteractionProgressFact>,
  ) {
    if (!isNonBlankString(interactionId) || typeof decode !== 'function') throw new TypeError('Progress requires an interaction identity and synchronous data contract');
    this.#decode = decode;
    this.#limits = validateProgressLimits(limits);
    this.#budget = budget;
    if (observation) {
      const receive = observation.receive.bind(observation);
      this.#observation = new ProgressChannel({
        receive: (fact) => {
          if (this.#observing) throw new RuntimeError('INTERACTION_PROGRESS_OBSERVATION_REENTRY', 'Progress observation cannot recursively publish lifecycle changes');
          this.#observing = true;
          try {
            return receive(fact);
          } finally {
            this.#observing = false;
          }
        },
        failed: observation.failed?.bind(observation),
      });
    }
  }

  /** The registry publishes creation only after this buffer is reachable by its identity. */
  installed(): void {
    if (this.#installed) return;
    this.#installed = true;
    this.observe('created');
  }

  get revision(): number {
    return this.#revision;
  }

  publish(value: Delta): InteractionPublication {
    if (this.#unavailable) return this.#unavailable;
    if (this.#sealed) return Object.freeze({ kind: 'sealed' });
    if (this.#publishing) return this.invalidate('invalid-data');
    this.#publishing = true;
    try {
      const decoded = this.#decode(captureInteractionValue(value));
      if (isPromise(decoded)) {
        void decoded.catch(() => undefined);
        throw new TypeError('Progress data contract must be synchronous');
      }
      const captured = captureInteractionValue(decoded);
      // A contract may synchronously close or invalidate its owner. Never revive it.
      if (this.#unavailable) return this.#unavailable;
      if (this.#sealed) return Object.freeze({ kind: 'sealed' });
      const bytes = Buffer.byteLength(JSON.stringify(captured), 'utf8');
      if (bytes > this.#limits.maxBytes - this.#bytes || this.#items.length >= this.#limits.maxEntries || !this.#budget.reserveBytes(bytes)) return this.invalidate('capacity');
      this.#bytes += bytes;
      const cursor = position(this.interactionId, ++this.#head);
      this.#items.push(Object.freeze({ kind: 'item', cursor, value: captured }));
      this.changed();
      return Object.freeze({ kind: 'published', cursor });
    } catch {
      if (this.#unavailable) return this.#unavailable;
      if (this.#sealed) return Object.freeze({ kind: 'sealed' });
      return this.invalidate('invalid-data');
    } finally {
      this.#publishing = false;
    }
  }

  seal(): void {
    if (this.#sealed) return;
    this.#sealed = true;
    this.observe('sealed');
    for (const reader of [...this.#readers]) {
      // Sealing may be reentered from an invalidation observer. Loss of retained
      // history always takes precedence over the producer having stopped.
      if (this.#unavailable) reader.finish(this.#unavailable);
      else if (reader.position.sequence === this.#head) reader.finish(Object.freeze({ kind: 'sealed', lastSequence: this.#head }));
    }
    this.changed();
  }

  invalidate(reason: string): Extract<Terminal, { kind: 'unavailable' }> {
    if (this.#unavailable) return this.#unavailable;
    this.#unavailable = Object.freeze({ kind: 'unavailable', reason });
    this.#items.length = 0;
    this.#budget.releaseBytes(this.#bytes);
    this.#bytes = 0;
    this.observe('unavailable', reason);
    for (const reader of [...this.#readers]) reader.finish(this.#unavailable);
    this.changed();
    return this.#unavailable;
  }

  open(after?: InteractionCursor): InteractionProgressReader<Delta> {
    const cursor = checkCursor(this.interactionId, after, this.#head);
    const state = this.inspectAfter(cursor.sequence);
    if (state.kind === 'unavailable' || state.kind === 'sealed') return new ProgressReader(undefined, cursor, state);
    if (this.#readers.size >= this.#limits.maxReaders || !this.#budget.reserveReader()) throw new RuntimeError('INTERACTION_PROGRESS_READERS', 'Progress reader capacity is exhausted');
    const reader = new ProgressReader(this, cursor);
    this.#readers.add(reader);
    this.observe('reader-opened');
    return reader;
  }

  inspectAfter(sequence: number): Inspection<Delta> {
    if (this.#unavailable) return this.#unavailable;
    const item = this.#items[sequence];
    if (item) return item;
    return this.#sealed ? Object.freeze({ kind: 'sealed', lastSequence: this.#head }) : { kind: 'pending' };
  }

  listen(wake: () => void): () => void {
    this.#waiters.add(wake);
    return () => this.#waiters.delete(wake);
  }

  release(reader: ProgressReader<Delta>): void {
    if (this.#readers.delete(reader)) {
      this.#budget.releaseReader();
      this.observe('reader-closed');
    }
  }

  private observe(phase: InteractionProgressFact['phase'], reason?: string): void {
    if (!this.#installed || !this.#observation) return;
    this.#observation.publish(Object.freeze({ interactionId: this.interactionId, phase, lastSequence: this.#head, entries: this.#items.length, bytes: this.#bytes, readers: this.#readers.size, ...(reason ? { reason } : {}) }));
  }

  private changed(): void {
    this.#revision += 1;
    for (const wake of [...this.#waiters]) wake();
  }
}

/** No history is rebuilt when a live buffer was never installed or no longer exists. */
export function unavailableProgressReader<Delta>(interactionId: string, reason: string, after?: InteractionCursor): InteractionProgressReader<Delta> {
  return new ProgressReader(undefined, checkCursor(interactionId, after), Object.freeze({ kind: 'unavailable', reason }));
}

class ProgressReader<Delta> implements InteractionProgressReader<Delta> {
  #position: InteractionCursor;
  #source?: InteractionProgress<Delta>;
  #terminal?: Terminal;
  #closed?: { readonly reason: unknown };
  #busy = false;
  #wake?: () => void;

  constructor(source: InteractionProgress<Delta> | undefined, cursor: InteractionCursor, terminal?: Terminal) {
    this.#source = source;
    this.#position = cursor;
    this.#terminal = terminal;
  }

  get position(): InteractionCursor {
    return this.#position;
  }

  next(options: { readonly waitMs: number; readonly signal?: AbortSignal }): Promise<InteractionProgressRead<Delta>> {
    if (this.#busy) return Promise.reject(new RuntimeError('INTERACTION_PROGRESS_CONCURRENT_READ', 'A progress reader permits only one pending next operation'));
    this.#busy = true;
    return this.read(options).finally(() => {
      this.#busy = false;
    });
  }

  close(reason: unknown = new RuntimeError('INTERACTION_PROGRESS_READER_CLOSED', 'Progress reader is closed')): void {
    if (this.#closed) return;
    this.#closed = { reason };
    this.detach();
    this.#wake?.();
  }

  finish(terminal: Terminal): void {
    if (this.#closed || this.#terminal) return;
    this.#terminal = terminal;
    this.detach();
    this.#wake?.();
  }

  private detach(): void {
    const source = this.#source;
    this.#source = undefined;
    source?.release(this);
  }

  private async read(options: { readonly waitMs: number; readonly signal?: AbortSignal }): Promise<InteractionProgressRead<Delta>> {
    const { waitMs, signal } = options;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new RangeError('Progress waitMs must be a nonnegative timer duration');
    const deadline = performance.now() + waitMs;
    while (true) {
      if (signal?.aborted) throw signal.reason;
      if (this.#closed) throw this.#closed.reason;
      if (this.#terminal) return this.#terminal;
      const source = this.#source!;
      const revision = source.revision;
      const result = source.inspectAfter(this.#position.sequence);
      if (result.kind === 'item') {
        this.#position = result.cursor;
        return result;
      }
      if (result.kind !== 'pending') {
        this.finish(result);
        return result;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { kind: 'wait-expired' };
      await this.wait(source, revision, remaining, signal);
    }
  }

  private wait(source: InteractionProgress<Delta>, revision: number, remaining: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (finished) return;
        finished = true;
        remove();
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        this.#wake = undefined;
        resolve();
      };
      const remove = source.listen(wake);
      this.#wake = wake;
      signal?.addEventListener('abort', wake, { once: true });
      // Register first, then recheck all conditions that could have invalidated the wait.
      if (source.revision !== revision || this.#closed || this.#terminal || signal?.aborted) wake();
      if (!finished) timer = setTimeout(wake, remaining);
    });
  }
}
