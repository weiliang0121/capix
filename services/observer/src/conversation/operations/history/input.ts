import type { TranscriptRangeReader, Memory } from '@capix/server-runtime/content';
import type { Message } from '@capix/protocol';

export interface SelectionInput {
  readonly message: Readonly<Message>;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

/** Messages visible before the current input, within this execution's fixed range. */
export function historyMessages(range: TranscriptRangeReader, message: Readonly<Message>): readonly { index: number; message: Readonly<Message> }[] {
  if (!range || range.length === 0 || range.read(range.end - 1) !== message) throw new Error('Execution input must be the final message in its fixed Transcript range');
  return Array.from({ length: range.length - 1 }, (_, offset) => {
    const index = range.start + offset;
    return Object.freeze({ index, message: range.read(index) });
  });
}
