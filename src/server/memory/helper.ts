import { isNull } from 'es-toolkit/predicate';
import { Memory } from './memory.js';
import type { MemoryCollection } from './collection.js';
import type { MemoryChange } from './change.js';
import type { Transcript } from '../transcript/transcript.js';
import { isNonBlankString } from '../value/string.js';
import { isNonEmptyArray } from '../value/array.js';

/** Applies accepted changes; recording is a separately supplied boundary observer. */
export class MemoryHelper {
  static apply(collection: MemoryCollection, transcript: Transcript, changes: readonly MemoryChange[], applied?: (memory: Memory, change: MemoryChange) => void): readonly Memory[] {
    const targets = new Set<string>();
    // Prepare all contents and targets before the first mutation.
    const prepared = changes.map((change) => {
      if (!isNonBlankString(change.change) || !isNonEmptyArray(change.sourceIndexes)) throw new TypeError('Memory change requires an explanation and evidence');
      for (const index of change.sourceIndexes) transcript.ref(index);
      if (change.action === 'create') {
        if (!isNull(change.memoryId)) throw new Error('Creating memory cannot specify an existing identity');
        return { change, memory: new Memory(transcript, change.result), result: undefined };
      }
      const memory = collection.get(change.memoryId);
      if (!memory || memory.transcript !== transcript) throw new Error('Memory update target does not exist in this Transcript');
      if (targets.has(memory.id)) throw new Error('A batch cannot update the same memory twice');
      targets.add(memory.id);
      return { change, memory, result: Memory.prepare(transcript, change.result) };
    });
    return prepared.map(({ change, memory, result }) => {
      if (result) memory.update(result);
      else collection.add(memory);
      applied?.(memory, change);
      return memory;
    });
  }
}
