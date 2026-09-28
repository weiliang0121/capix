import { MemoryRecordHelper } from '../records/memory/helper.js';
import { writeRecord } from '../records/error.js';
import { isEqual, isNull } from 'es-toolkit/predicate';
import { Memory, updateMemory } from './memory.js';
import type { MemoryChange } from './change.js';
import type { Transcript } from '../transcript/transcript.js';
import type { RuntimeRecorder } from '../records/recorder.js';
import type { ChangeSource } from '../records/source.js';
import { isNonBlankString } from '../value/string.js';
import { isNonEmptyArray, hasUniqueItems } from '../value/array.js';

/** Current running memory. Every formal mutation is validated and recorded at this boundary. */
export class Memories {
  readonly #items = new Map<string, Memory>();
  constructor(
    readonly transcript: Transcript,
    private readonly recorder?: RuntimeRecorder,
  ) {}

  get(id: string): Memory | undefined {
    return this.#items.get(id);
  }
  values(): readonly Memory[] {
    return [...this.#items.values()];
  }
  snapshot() {
    return this.values().map((memory) => memory.toJSON());
  }

  apply(changes: readonly MemoryChange[], source?: ChangeSource): readonly Memory[] {
    const targets = new Set<string>();
    // The complete batch is checked before the first mutation. Recording failure does not roll back facts.
    const prepared = changes.map((change) => {
      if (!isNonBlankString(change.change) || !isNonEmptyArray(change.sourceIndexes) || !hasUniqueItems(change.sourceIndexes)) throw new TypeError('Memory change requires an explanation and unique evidence');
      for (const index of change.sourceIndexes) this.transcript.ref(index);
      const result = Memory.prepare(this.transcript, change.result);
      if (!change.sourceIndexes.every((index) => result.sourceIndexes.includes(index))) throw new Error('Memory result must include change evidence');
      if (change.action === 'create') {
        if (!isNull(change.memoryId)) throw new Error('Creating memory cannot specify an existing identity');
        return { change, result, memory: undefined };
      }
      if (change.action !== 'update') throw new Error('Unknown memory change action');
      const memory = this.#items.get(change.memoryId);
      if (!memory) throw new Error('Memory update target does not exist in this Runtime');
      if (targets.has(memory.id)) throw new Error('A batch cannot update the same memory twice');
      targets.add(memory.id);
      return { change, result, memory };
    });
    const applied: Memory[] = [];
    for (const { change, result, memory: previous } of prepared) {
      if (previous && isEqual(previous.snapshot(), result)) continue;
      const memory = previous ?? new Memory(this.transcript, result);
      if (previous) updateMemory(memory, result);
      else this.#items.set(memory.id, memory);
      applied.push(memory);
      const recorder = this.recorder;
      if (recorder) writeRecord(() => recorder.add(MemoryRecordHelper.create(memory.id, { action: change.action, change: change.change, sourceIndexes: change.sourceIndexes, result: memory.snapshot() }, source)));
    }
    return applied;
  }
}
