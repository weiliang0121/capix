import type { Stable } from '@weiliang0121/capix-contracts';
import type { MemoryApplyState } from './apply.js';
import type { MemoryContentContractIdentity, MemoryItem } from './memory.js';

/** Current format only. This is Stable material, not an implicit JSON encoding. */
export interface MemoriesState<Metadata = never> {
  readonly version: 2;
  readonly id: string;
  readonly contentContract: MemoryContentContractIdentity;
  readonly sequence: number;
  readonly items: readonly MemoryItem<Metadata>[];
  readonly applies?: readonly MemoryApplyState<Metadata>[];
}

/** An incremental batch. Preserve existing item positions on update. */
export interface MemoriesCommit<Metadata = never> {
  readonly memoriesId: string;
  readonly contentContract: MemoryContentContractIdentity;
  readonly expectedSequence: number;
  readonly sequence: number;
  readonly upserts: readonly MemoryItem<Metadata>[];
  readonly fixed?: MemoryApplyState<Metadata>;
}

/**
 * The adapter explicitly owns a faithful codec for its supported metadata domain.
 * Commit content and fixed confirmation together, synchronously, returning undefined.
 * Any failure leaves outcome uncertain: reload from authoritative storage before reuse.
 */
export interface MemoriesPersistence<Metadata = never> {
  commit(change: Stable<MemoriesCommit<Metadata>>): undefined;
}
