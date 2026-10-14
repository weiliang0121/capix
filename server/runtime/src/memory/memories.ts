import { publishFact, type ChangeProvenance } from '../observation/publish.js';
import type { EventConsumer } from '../observation/observer.js';
import type { MemoryEvent } from '@capix/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import { randomUUID } from 'node:crypto';
import { isEqual, isNull } from 'es-toolkit/predicate';
import { Memory, restoreMemory, updateMemory } from './memory.js';
import type { MemoryChange } from './change.js';
import type { Transcript } from '../transcript/transcript.js';
import { isNonBlankString } from '../value/string.js';
import { isNonEmptyArray, hasUniqueItems } from '../value/array.js';
import { prepareMemoryResultSources } from './source.js';
import type { MemoriesCommit, MemoriesPersistence, MemoriesState } from './persistence.js';
import { isArray, isSafeInteger } from 'es-toolkit/compat';
import { isObject } from '../value/object.js';
import { combineFaults } from '../observation/error.js';
import type { MemoryFixedApply, MemoryApplyReceipt, MemoryApplyState } from './apply.js';
import { RuntimeError } from '../errors/error.js';

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
      return this.applyBatch(changes, provenance);
    } finally {
      this.#mutating = false;
    }
  }

  confirmFixed(value: MemoryFixedApply): MemoryApplyReceipt | undefined {
    const request = this.acceptFixed(value);
    const saved = this.#applies.get(applyKey(request));
    if (saved && !isEqual(saved.request, request)) throw new RuntimeError('MEMORY_APPLY_CONFLICT', '固定记忆批次与原操作不一致。');
    return saved?.receipt;
  }

  applyFixed(value: MemoryFixedApply, provenance: ChangeProvenance<MemoryEvent> = {}): MemoryApplyReceipt {
    if (this.#mutating) throw new Error('Memory persistence or change publication cannot reenter mutation');
    this.#mutating = true;
    try {
      const request = this.acceptFixed(value);
      const receipt = this.confirmFixed(request);
      if (receipt) return receipt;
      this.applyBatch(request.changes, provenance, request);
      return this.#applies.get(applyKey(request))!.receipt;
    } finally {
      this.#mutating = false;
    }
  }

  private acceptFixed(value: MemoryFixedApply): MemoryFixedApply {
    if (!isObject(value) || value.contract?.key !== 'memories.apply' || value.contract.version !== 1 || value.memoriesId !== this.id || !isObject(value.operation) || !isNonBlankString(value.operation.contextId) || !isNonBlankString(value.operation.position) || !isArray(value.changes)) throw new TypeError('Invalid fixed memory apply request');
    const changes = Object.freeze(
      value.changes.map((change: MemoryChange) => {
        if (!isObject(change) || !isNonBlankString(change.change) || !isNonEmptyArray(change.sourceIndexes) || !hasUniqueItems(change.sourceIndexes) || (change.action === 'create' ? change.memoryId !== null : change.action !== 'update' || !isNonBlankString(change.memoryId))) throw new TypeError('Invalid fixed memory change');
        for (const index of change.sourceIndexes) this.transcript.ref(index);
        const result = Memory.prepare(this.transcript, change.result);
        const sourceResults = prepareMemoryResultSources(this.transcript, change.sourceResults);
        if (!change.sourceIndexes.every((index) => result.sourceIndexes.includes(index)) || sourceResults?.some((source) => !result.sourceResults?.some((candidate) => isEqual(source, candidate)))) throw new TypeError('Invalid fixed memory evidence');
        return Object.freeze({ action: change.action, memoryId: change.memoryId, change: change.change, sourceIndexes: Object.freeze([...change.sourceIndexes]), ...(sourceResults ? { sourceResults } : {}), result }) as MemoryChange;
      }),
    );
    return Object.freeze({ contract: Object.freeze({ key: 'memories.apply', version: 1 }), operation: Object.freeze({ ...value.operation }), memoriesId: this.id, changes });
  }

  private applyBatch(changes: readonly MemoryChange[], provenance: ChangeProvenance<MemoryEvent>, request?: MemoryFixedApply): readonly Memory[] {
    if (!isArray(changes)) throw new TypeError('Memory changes must be an array');
    const targets = new Set<string>();
    // Preparation includes identities and event bodies; nothing after persistence revalidates user data.
    const prepared = Array.from(changes, (change: MemoryChange) => {
      if (!isObject(change) || !isNonBlankString(change.change) || !isNonEmptyArray(change.sourceIndexes) || !hasUniqueItems(change.sourceIndexes)) throw new TypeError('Memory change requires an explanation and unique evidence');
      for (const index of change.sourceIndexes) this.transcript.ref(index);
      const result = Memory.prepare(this.transcript, change.result);
      const sourceResults = prepareMemoryResultSources(this.transcript, change.sourceResults);
      if (!change.sourceIndexes.every((index) => result.sourceIndexes.includes(index))) throw new Error('Memory result must include change evidence');
      if (sourceResults?.some((source) => !result.sourceResults?.some((candidate) => isEqual(source, candidate)))) throw new Error('Memory result must include the unchanged result sources of this change');
      if (change.action === 'create') {
        if (!isNull(change.memoryId)) throw new Error('Creating memory cannot specify an existing identity');
        return { change, result, sourceResults, memory: undefined };
      }
      if (change.action !== 'update') throw new Error('Unknown memory change action');
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
    const result: unknown = this.persistence?.commit(change);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Memory persistence must complete synchronously and return undefined');
    }
  }
}

function applyKey(request: MemoryFixedApply): string {
  return JSON.stringify([request.operation.contextId, request.operation.position]);
}
