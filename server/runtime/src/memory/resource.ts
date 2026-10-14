import { ResourceOffer } from '../resource/offer.js';
import type { Memories } from './memories.js';
import type { MemoryChange } from './change.js';

type MemorySnapshot = ReturnType<Memories['snapshot']>;
export interface CapturedMemories {
  readonly memoriesId: string;
  readonly sequence: number;
  readonly items: Readonly<MemorySnapshot>;
}

export const MemoryResource = Object.freeze({
  snapshot: new ResourceOffer<Memories | CapturedMemories, Readonly<MemorySnapshot>, CapturedMemories>('memories.snapshot', (captured: CapturedMemories) => captured.items, 'binding', {
    capture: (memories) => ('items' in memories ? memories : { memoriesId: memories.id, sequence: memories.sequence, items: Object.freeze(memories.snapshot().map((memory) => Object.freeze(memory))) }),
    describe: (captured: CapturedMemories) => ({ memoriesId: captured.memoriesId, sequence: captured.sequence, memoryIds: captured.items.map((memory) => memory.id) }),
  }),
  apply: new ResourceOffer(
    'memories.apply',
    (memories: Memories, activity) =>
      Object.freeze({
        apply(changes: readonly MemoryChange[]): void {
          const startSequence = memories.sequence;
          activity.runSync('apply', { input: () => ({ count: changes.length }), output: (result) => ({ memoriesId: memories.id, startSequence, endSequence: memories.sequence, memoryIds: result.map((memory) => memory.id) }) }, () => memories.apply(changes, { origin: activity.origin, observation: activity.memoryObservation }));
        },
        applyFixed(input: { readonly position: string; readonly changes: readonly MemoryChange[] }) {
          return activity.runSync('applyFixed', { input: () => ({ position: input.position, count: input.changes.length }), output: (receipt) => receipt }, () => {
            if (!activity.origin) throw new Error('Fixed memory application requires a calling identity');
            return memories.applyFixed({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId: activity.origin.contextId, position: input.position }, memoriesId: memories.id, changes: input.changes }, { origin: activity.origin, observation: activity.memoryObservation });
          });
        },
      }),
    'access',
    { describe: (memories) => ({ memoriesId: memories.id }) },
  ),
});
