import { MemoryFacts } from './event.js';
import { type Stable } from '@weiliang0121/capix-contracts';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { Memories } from './memories.js';
import type { MemoryMutation } from './change.js';
import type { MemoryApplication, MemoryBasis } from './memory.js';
import type { MemoryFixedApply } from './apply.js';

/** Create one accurately typed pair of offers and share it between assembly and authors. */
export function memoryResources<Metadata = never>() {
  return Object.freeze({
    read: new ResourceOffer({
      name: 'memories.read',
      expose: (memories: Memories<Metadata>, activity) =>
        Object.freeze({
          read(id: string) {
            return activity.runSync('read', { input: () => ({ memoryId: id }), output: (result) => ({ memoriesId: memories.id, memoryId: id, found: result !== undefined }) }, () => memories.read(id));
          },
          snapshot() {
            return activity.runSync('snapshot', { output: (result) => ({ memoriesId: result.basis.memoriesId, sequence: result.basis.sequence, count: result.items.length }) }, () => memories.snapshot());
          },
        }),
      timing: 'access',
      describe: (memories) => ({ memoriesId: memories.id }),
    }),
    apply: new ResourceOffer({
      name: 'memories.apply',
      expose: (memories: Memories<Metadata>, activity) =>
        Object.freeze({
          apply(changes: readonly MemoryMutation<Metadata>[] | Stable<readonly MemoryMutation<Metadata>[]>, expected?: MemoryBasis) {
            return activity.runSync('apply', { output: (result: Stable<MemoryApplication<Metadata>>) => ({ memoriesId: result.after.memoriesId, startSequence: result.before.sequence, endSequence: result.after.sequence, memoryIds: result.changed.map((item) => item.id) }) }, (operation) => memories.apply(changes, { expected, origin: operation.origin, observation: operation.facts(MemoryFacts) }));
          },
          applyFixed(input: { readonly position: string; readonly changes: readonly MemoryMutation<Metadata>[] } | Stable<{ readonly position: string; readonly changes: readonly MemoryMutation<Metadata>[] }>, expected?: MemoryBasis) {
            return activity.runSync('applyFixed', { output: (receipt) => receipt }, (operation) => {
              if (!activity.origin) throw new Error('Fixed memory application requires a calling identity');
              const request = { contract: { key: 'memories.apply' as const, version: 2 as const }, contentContract: memories.contentContract, operation: { contextId: activity.origin.contextId }, memoriesId: memories.id, command: input, ...(expected === undefined ? {} : { expected }) };
              return memories.applyFixed(request as MemoryFixedApply<Metadata> | Stable<MemoryFixedApply<Metadata>>, { origin: operation.origin, observation: operation.facts(MemoryFacts) });
            });
          },
        }),
      timing: 'access',
      describe: (memories) => ({ memoriesId: memories.id }),
    }),
  });
}
