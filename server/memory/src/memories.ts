import { publishFact, combineFaults, type ChangeProvenance, type EventConsumer, type ChangeCapture } from '@capix/changes';
import type { MemoryEvent } from '@capix/protocol';
import { randomUUID } from 'node:crypto';
import { isEqual } from 'es-toolkit/predicate';
import { Memory, restoreMemory, updateMemory } from './memory.js';
import { prepareMemoryChanges, type MemoryChange } from './change.js';
import type { Transcript } from '@capix/transcript';
import { isNonBlankString, hasUniqueItems, isObject } from './validation.js';
import type { MemoriesCommit, MemoriesPersistence, MemoriesState } from './persistence.js';
import { isArray, isSafeInteger } from 'es-toolkit/compat';
import type { MemoryFixedApply, MemoryApplyReceipt, MemoryApplyState } from './apply.js';
import { RuntimeError } from '@capix/contracts';
import { PersistenceError } from '@capix/diagnostics';

export interface MemoriesOptions {
  observation?: EventConsumer<MemoryEvent>;
  changes?: ChangeCapture<MemoryEvent>;
  persistence?: MemoriesPersistence;
}

/** Current running memory. Every formal mutation is validated and recorded at this boundary. */
export class Memories {
  #id: string = randomUUID();
  #sequence = 0;
  #mutating = false;

  get id(): string {
    return this.#id;
  }

  /** Number of formal changes in this collection, independent of recording. */
  get sequence(): number {
    return this.#sequence;
  }

  readonly #items = new Map<string, Memory>();
  readonly #applies = new Map<string, MemoryApplyState>();
  private readonly observation?: EventConsumer<MemoryEvent>;
  private readonly changes?: ChangeCapture<MemoryEvent>;
  private readonly persistence?: MemoriesPersistence;
  constructor(
    readonly transcript: Transcript,
    options: MemoriesOptions = {},
  ) {
    this.observation = options.observation;
    this.changes = options.changes;
    this.persistence = options.persistence;
  }

  /** Restore content directly; applying old create/update proposals would fabricate new facts. */
  static restore(state: MemoriesState, transcript: Transcript, options: MemoriesOptions = {}): Memories {
    if (!isObject(state) || !isNonBlankString(state.id) || state.transcriptId !== transcript.id || !isArray(state.items)) throw new TypeError('Invalid persisted memory collection');
    if (!isSafeInteger(state.sequence) || state.sequence < state.items.length || (!state.items.length && state.sequence !== 0)) throw new TypeError('Invalid persisted memory sequence');
    const restored = new Memories(transcript, options);
    for (const item of state.items) {
      const memory = restoreMemory(transcript, item);
      if (restored.#items.has(memory.id)) throw new TypeError('Duplicate persisted memory identity');
      restored.#items.set(memory.id, memory);
    }
    restored.#id = state.id;
    restored.#sequence = state.sequence;
    if (state.applies !== undefined) {
      if (!isArray(state.applies)) throw new TypeError('Invalid persisted memory applies');
      let previousSequence = 0;
      for (const saved of state.applies) {
        const request = restored.acceptFixed(saved.request);
        const receipt = saved.receipt;
        if (!isObject(receipt) || receipt.memoriesId !== restored.id || !isSafeInteger(receipt.startSequence) || receipt.startSequence < previousSequence || !isSafeInteger(receipt.sequence) || receipt.sequence < receipt.startSequence || receipt.sequence > state.sequence || !isArray(receipt.memoryIds) || !hasUniqueItems(receipt.memoryIds) || receipt.memoryIds.length !== receipt.sequence - receipt.startSequence || receipt.memoryIds.some((id) => !restored.#items.has(id))) throw new TypeError('Invalid persisted memory apply receipt');
        const key = applyKey(request);
        if (restored.#applies.has(key)) throw new TypeError('Duplicate persisted memory apply operation');
        restored.#applies.set(key, Object.freeze({ request, receipt: Object.freeze({ memoriesId: restored.id, startSequence: receipt.startSequence, sequence: receipt.sequence, memoryIds: Object.freeze([...receipt.memoryIds]) }) }));
        previousSequence = receipt.sequence;
      }
    }
    return restored;
  }

  exportState(): MemoriesState {
    return Object.freeze({ id: this.id, transcriptId: this.transcript.id, sequence: this.#sequence, items: Object.freeze(this.values().map((memory) => Object.freeze(memory.toJSON()))), ...(this.#applies.size ? { applies: Object.freeze([...this.#applies.values()]) } : {}) });
  }

  get(id: string): Memory | undefined {
    return this.#items.get(id);
  }
  values(): readonly Memory[] {
    return [...this.#items.values()];
  }
  snapshot() {
    return this.values().map((memory) => memory.toJSON());
  }

  apply(changes: readonly MemoryChange[], provenance: ChangeProvenance<MemoryEvent> = {}): readonly Memory[] {
    if (this.#mutating) throw new Error('Memory persistence or change publication cannot reenter mutation');
    this.#mutating = true;
    try {
      return this.applyPrepared(prepareMemoryChanges(this.transcript, changes), provenance);
    } finally {
      this.#mutating = false;
    }
  }

  confirmFixed(value: MemoryFixedApply): MemoryApplyReceipt | undefined {
    return this.confirmAccepted(this.acceptFixed(value));
  }

  applyFixed(value: MemoryFixedApply, provenance: ChangeProvenance<MemoryEvent> = {}): MemoryApplyReceipt {
    if (this.#mutating) throw new Error('Memory persistence or change publication cannot reenter mutation');
    this.#mutating = true;
    try {
      const request = this.acceptFixed(value);
      const receipt = this.confirmAccepted(request);
      if (receipt) return receipt;
      this.applyPrepared(request.changes, provenance, request);
      return this.#applies.get(applyKey(request))!.receipt;
    } finally {
      this.#mutating = false;
    }
  }

  private acceptFixed(value: MemoryFixedApply): MemoryFixedApply {
    if (!isObject(value)) throw new TypeError('Invalid fixed memory apply request');
    const contract = value.contract;
    const origin = value.operation;
    if (contract?.key !== 'memories.apply' || contract.version !== 1 || value.memoriesId !== this.id || !isObject(origin)) throw new TypeError('Invalid fixed memory apply request');
    const operation = Object.freeze({ contextId: origin.contextId, position: origin.position });
    if (!isNonBlankString(operation.contextId) || !isNonBlankString(operation.position)) throw new TypeError('Invalid fixed memory apply request');
    const changes = prepareMemoryChanges(this.transcript, value.changes);
    return Object.freeze({ contract: Object.freeze({ key: 'memories.apply', version: 1 }), operation, memoriesId: this.id, changes });
  }

  private confirmAccepted(request: MemoryFixedApply): MemoryApplyReceipt | undefined {
    const saved = this.#applies.get(applyKey(request));
    if (saved && !isEqual(saved.request, request)) throw new RuntimeError('MEMORY_APPLY_CONFLICT', '固定记忆批次与原操作不一致。');
    return saved?.receipt;
  }

  private applyPrepared(changes: readonly MemoryChange[], provenance: ChangeProvenance<MemoryEvent>, request?: MemoryFixedApply): readonly Memory[] {
    const targets = new Set<string>();
    // Preparation includes identities and event bodies; nothing after persistence revalidates user data.
    const prepared = changes.map((change) => {
      const result = change.result;
      const sourceResults = change.sourceResults;
      if (change.action === 'create') {
        return { change, result, sourceResults, memory: undefined };
      }
      const memory = this.#items.get(change.memoryId);
      if (!memory) throw new Error('Memory update target does not exist in this Runtime');
      for (const source of result.sourceResults ?? []) {
        const previous = memory.sourceResults?.find((candidate) => candidate.id === source.id);
        if (previous && !isEqual(previous, source)) throw new Error('Memory result source identity cannot change its receipt');
      }
      if (targets.has(memory.id)) throw new Error('A batch cannot update the same memory twice');
      targets.add(memory.id);
      return { change, result, sourceResults, memory };
    });
    const mutations: { memory: Memory; event: MemoryEvent; created: boolean }[] = [];
    for (const { change, result, sourceResults, memory: previous } of prepared) {
      if (previous && isEqual(previous.snapshot(), result)) continue;
      const memory = previous ?? new Memory(this.transcript, result);
      const sequence = this.#sequence + mutations.length + 1;
      if (!isSafeInteger(sequence)) throw new RangeError('Memory sequence is exhausted');
      const event: MemoryEvent = Object.freeze({ type: 'memory', memoriesId: this.id, sequence, occurredAt: new Date().toISOString(), ...(provenance.origin ? { origin: Object.freeze({ ...provenance.origin }) } : {}), change: Object.freeze({ action: change.action, memoryId: memory.id, explanation: change.change, sourceIndexes: Object.freeze([...change.sourceIndexes]), ...(sourceResults ? { sourceResults } : {}), result }) });
      mutations.push({ memory, event, created: !previous });
    }
    if (!mutations.length && !request) return [];
    const sequence = mutations.at(-1)?.event.sequence ?? this.#sequence;
    const upserts = Object.freeze(mutations.map(({ memory, event }) => Object.freeze({ id: memory.id, ...event.change.result })));
    const fixed: MemoryApplyState | undefined = request ? Object.freeze({ request, receipt: Object.freeze({ memoriesId: this.id, startSequence: this.#sequence, sequence, memoryIds: Object.freeze(upserts.map((memory) => memory.id)) }) }) : undefined;
    this.commit(Object.freeze({ memoriesId: this.id, transcriptId: this.transcript.id, expectedSequence: this.#sequence, sequence, upserts, ...(fixed ? { fixed } : {}) }));
    for (const { memory, event, created } of mutations) {
      if (created) this.#items.set(memory.id, memory);
      else updateMemory(memory, event.change.result);
    }
    this.#sequence = sequence;
    if (fixed) this.#applies.set(applyKey(fixed.request), fixed);
    const faults: unknown[] = [];
    for (const { event } of mutations) {
      try {
        publishFact(event, this.changes, provenance.observation ?? this.observation);
      } catch (error) {
        faults.push(error);
      }
    }
    const fault = combineFaults(faults);
    if (fault !== undefined) throw fault;
    return mutations.map(({ memory }) => memory);
  }

  private commit(change: MemoriesCommit): void {
    try {
      const result: unknown = this.persistence?.commit(change);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError('Memory persistence must complete synchronously and return undefined');
      }
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause;
      throw new PersistenceError('memories.commit', cause);
    }
  }
}

function applyKey(request: MemoryFixedApply): string {
  return JSON.stringify([request.operation.contextId, request.operation.position]);
}
