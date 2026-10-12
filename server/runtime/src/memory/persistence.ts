import type { MemoryContent } from '@capix/protocol';

export interface MemoryState extends MemoryContent {
  readonly id: string;
}

/** Items retain creation order even when individual memories are updated. */
export interface MemoriesState {
  readonly id: string;
  readonly transcriptId: string;
  readonly sequence: number;
  readonly items: readonly MemoryState[];
}

/** One validated apply batch. The store preserves existing item positions on update. */
export interface MemoriesCommit {
  readonly memoriesId: string;
  readonly transcriptId: string;
  readonly expectedSequence: number;
  readonly sequence: number;
  readonly upserts: readonly MemoryState[];
}

export interface MemoriesPersistence {
  commit(change: MemoriesCommit): undefined;
}
