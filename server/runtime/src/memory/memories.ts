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
    return restored;
  }

  exportState(): MemoriesState {
    return Object.freeze({ id: this.id, transcriptId: this.transcript.id, sequence: this.#sequence, items: Object.freeze(this.values().map((memory) => Object.freeze(memory.toJSON()))) });
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

  private applyBatch(changes: readonly MemoryChange[], provenance: ChangeProvenance<MemoryEvent>): readonly Memory[] {
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
    if (!mutations.length) return [];
    const sequence = mutations.at(-1)!.event.sequence;
    const upserts = Object.freeze(mutations.map(({ memory, event }) => Object.freeze({ id: memory.id, ...event.change.result })));
    this.commit(Object.freeze({ memoriesId: this.id, transcriptId: this.transcript.id, expectedSequence: this.#sequence, sequence, upserts }));
    for (const { memory, event, created } of mutations) {
      if (created) this.#items.set(memory.id, memory);
      else updateMemory(memory, event.change.result);
    }
    this.#sequence = sequence;
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
