import type { MemoryContent } from '@capix/protocol';
import type { MemoryApplyState } from './apply.js';

export interface MemoryState extends MemoryContent {
  readonly id: string;
}

/** Items retain creation order even when individual memories are updated. */
export interface MemoriesState {
  readonly id: string;
  readonly transcriptId: string;
  readonly sequence: number;
  readonly items: readonly MemoryState[];
  readonly applies?: readonly MemoryApplyState[];
}

/** One validated apply batch. The store preserves existing item positions on update. */
export interface MemoriesCommit {
  readonly memoriesId: string;
  readonly transcriptId: string;
  readonly expectedSequence: number;
  readonly sequence: number;
  readonly upserts: readonly MemoryState[];
  readonly fixed?: MemoryApplyState;
}

/**
 * Commit before installing the batch. The entity marks port failures and invalid
 * synchronous returns as PersistenceError; that classification does not establish commit outcome.
 */
export interface MemoriesPersistence {
  commit(change: MemoriesCommit): undefined;
}
