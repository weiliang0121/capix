import { ResourceOffer } from '@capix/resources';
import { RuntimeError } from '@capix/contracts';
import type { Memories } from './memories.js';
import type { MemoryChange } from './change.js';
import type { MemoryState } from './persistence.js';
import { isNonBlankString, isObject } from './validation.js';

type MemorySnapshot = ReturnType<Memories['snapshot']>;
export interface CapturedMemories {
  readonly memoriesId: string;
  readonly sequence: number;
  readonly items: Readonly<MemorySnapshot>;
}

export interface MemoryBasis {
  readonly memoriesId: string;
  readonly transcriptId: string;
  readonly sequence: number;
}

export interface MemoryApplication extends MemoryBasis {
  readonly startSequence: number;
  readonly items: readonly Readonly<MemoryState>[];
}

export const MemoryResource = Object.freeze({
  snapshot: new ResourceOffer<Memories | CapturedMemories, Readonly<MemorySnapshot>, CapturedMemories>({
    name: 'memories.snapshot',
    expose: (captured: CapturedMemories) => captured.items,
    timing: 'binding',
    capture: (memories) => ('items' in memories ? memories : { memoriesId: memories.id, sequence: memories.sequence, items: Object.freeze(memories.snapshot().map((memory) => Object.freeze(memory))) }),
    describe: (captured: CapturedMemories) => ({ memoriesId: captured.memoriesId, sequence: captured.sequence, memoryIds: captured.items.map((memory) => memory.id) }),
  }),
  apply: new ResourceOffer({
    name: 'memories.apply',
    expose: (memories: Memories, activity) =>
      Object.freeze({
        apply(changes: readonly MemoryChange[], expected?: MemoryBasis): MemoryApplication {
          return activity.runSync('apply', { input: () => ({ count: changes.length }), output: (result) => ({ memoriesId: result.memoriesId, startSequence: result.startSequence, endSequence: result.sequence, memoryIds: result.items.map((memory) => memory.id) }) }, () => {
            if (expected !== undefined) {
              if (!isObject(expected)) throw new TypeError('Invalid memory application basis');
              const { memoriesId, transcriptId, sequence } = expected;
              if (!isNonBlankString(memoriesId) || !isNonBlankString(transcriptId) || !Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Invalid memory application basis');
              if (memoriesId !== memories.id || transcriptId !== memories.transcript.id || sequence !== memories.sequence) throw new RuntimeError('MEMORY_BASIS_CONFLICT', 'Memory application basis does not match the current collection');
            }
            const startSequence = memories.sequence;
            const applied = memories.apply(changes, { origin: activity.origin, observation: activity.memoryObservation });
            return Object.freeze({ memoriesId: memories.id, transcriptId: memories.transcript.id, startSequence, sequence: memories.sequence, items: Object.freeze(applied.map((memory) => Object.freeze(memory.toJSON()))) });
          });
        },
        applyFixed(input: { readonly position: string; readonly changes: readonly MemoryChange[] }) {
          return activity.runSync('applyFixed', { input: () => ({ position: input.position, count: input.changes.length }), output: (receipt) => receipt }, () => {
            if (!activity.origin) throw new Error('Fixed memory application requires a calling identity');
            return memories.applyFixed({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId: activity.origin.contextId, position: input.position }, memoriesId: memories.id, changes: input.changes }, { origin: activity.origin, observation: activity.memoryObservation });
          });
        },
      }),
    timing: 'access',
    describe: (memories) => ({ memoriesId: memories.id }),
  }),
});
