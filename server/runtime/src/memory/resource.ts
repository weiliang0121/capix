import { ResourceOffer } from '../resource/offer.js';
import type { Memories } from './memories.js';
import type { MemoryChange } from './change.js';
import type { ChangeSource } from '../records/source.js';

export const MemoryResource = Object.freeze({
  snapshot: new ResourceOffer('memories.snapshot', (memories: Memories) => Object.freeze(memories.snapshot().map((memory) => Object.freeze(memory))), 'binding'),
  apply: new ResourceOffer('memories.apply', (memories: Memories) =>
    Object.freeze({
      apply(changes: readonly MemoryChange[], source?: ChangeSource): void {
        memories.apply(changes, source);
      },
    }),
  ),
});
