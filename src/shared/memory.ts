/** Current understanding content, also used by HTTP views and immutable record snapshots. */
export interface MemoryContent {
  readonly topic: string;
  readonly content: string;
  readonly sourceIndexes: readonly number[];
}
