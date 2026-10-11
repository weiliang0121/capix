import type { Message, FileTask } from '@capix/protocol';
import type { Memory, TranscriptRangeReader } from '@capix/server-runtime/content';
import type { Selection } from '../../model/types.js';
import { isSafeInteger } from 'es-toolkit/compat';

export interface RequestUnderstandingInput {
  readonly message: Readonly<Message>;
  readonly selection: Selection;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
  readonly fileTask?: FileTask;
}

/** The last exchange supplements selection so a direct clarification reply has its question. */
export function understandingHistory(input: RequestUnderstandingInput, range: TranscriptRangeReader) {
  if (range.length === 0 || range.read(range.end - 1) !== input.message) throw new Error('Execution input must be the final message in its fixed Transcript range');
  const selected = input.selection.historyIndexes.map((index) => {
    if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
    return index;
  });
  const recent = Array.from({ length: Math.min(2, range.length - 1) }, (_, offset) => range.end - 2 - offset);
  const indexes = [...new Set([...recent, ...selected])];
  return indexes.map((index) => Object.freeze({ index, ...range.read(index) }));
}
