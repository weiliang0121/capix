import { ResourceOffer } from '@weiliang0121/capix-resources';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { Memories } from './memories.js';
import type { MemoryChange } from './change.js';
import type { MemoryState } from './persistence.js';
import type { MemoryFixedApply } from './apply.js';
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

function checkBasis(memories: Memories, expected: MemoryBasis, sequence: number) {
  if (!isObject(expected)) throw new TypeError('Invalid memory application basis');
  if (!isNonBlankString(expected.memoriesId) || !isNonBlankString(expected.transcriptId) || !Number.isSafeInteger(expected.sequence) || expected.sequence < 0) throw new TypeError('Invalid memory application basis');
  if (expected.memoriesId !== memories.id || expected.transcriptId !== memories.transcript.id || expected.sequence !== sequence) throw new RuntimeError('MEMORY_BASIS_CONFLICT', 'Memory application basis does not match the fixed collection version');
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
            if (expected !== undefined) checkBasis(memories, expected, memories.sequence);
            const startSequence = memories.sequence;
            const applied = memories.apply(changes, { origin: activity.origin, observation: activity.memoryObservation });
            return Object.freeze({ memoriesId: memories.id, transcriptId: memories.transcript.id, startSequence, sequence: memories.sequence, items: Object.freeze(applied.map((memory) => Object.freeze(memory.toJSON()))) });
          });
        },
        applyFixed(input: { readonly position: string; readonly changes: readonly MemoryChange[] }, expected?: MemoryBasis) {
          return activity.runSync('applyFixed', { input: () => ({ position: input.position, count: input.changes.length }), output: (receipt) => receipt }, () => {
            if (!activity.origin) throw new Error('Fixed memory application requires a calling identity');
            const request: MemoryFixedApply = { contract: { key: 'memories.apply', version: 1 }, operation: { contextId: activity.origin.contextId, position: input.position }, memoriesId: memories.id, changes: input.changes };
            // A confirmed effect belongs to its original basis, even after later writes.
            // Only an absent receipt permits a new write against the current version.
            const confirmed = memories.confirmFixed(request);
            if (expected !== undefined) checkBasis(memories, expected, confirmed?.startSequence ?? memories.sequence);
            return confirmed ?? memories.applyFixed(request, { origin: activity.origin, observation: activity.memoryObservation });
          });
        },
      }),
    timing: 'access',
    describe: (memories) => ({ memoriesId: memories.id }),
  }),
});
