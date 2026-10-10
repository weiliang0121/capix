import type { MemoryContent } from '@capix/protocol';

/** A proposed change. It becomes a record only after application succeeds. */
export type MemoryChange = {
  readonly change: string;
  readonly sourceIndexes: readonly number[];
  readonly result: MemoryContent;
} & ({ readonly action: 'create'; readonly memoryId: null } | { readonly action: 'update'; readonly memoryId: string });
