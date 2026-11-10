import type { FileReceipt } from '../conversation/files.js';

/** An accepted file creation, copied into memory rather than linked to optional records.
 * answerIndex locates the answer in this memory's Transcript; it is not proof of creation.
 * The receipt describes the historical write, not the file's current existence or contents.
 */
export interface MemoryResultSource {
  readonly id: string;
  readonly kind: 'file-created';
  readonly answerIndex: number;
  readonly receipt: FileReceipt;
}

/** Current understanding content, also used by HTTP views and immutable record snapshots. */
export interface MemoryContent {
  readonly topic: string;
  readonly content: string;
  readonly sourceIndexes: readonly number[];
  readonly sourceResults?: readonly MemoryResultSource[];
}
