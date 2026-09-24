import type { ExecutionContext } from '../../context/execution.js';
import type { Message } from '../../../shared/transcript/message.js';
import type { Memory } from '../../memory/memory.js';

export interface SelectionInput {
  readonly message: Readonly<Message>;
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

/** Messages visible before the current input, within this execution's fixed range. */
export function historyMessages(execution: ExecutionContext): readonly { index: number; message: Readonly<Message> }[] {
  const range = execution.transcriptRange;
  if (!range || range.length === 0 || range.read(range.end - 1) !== execution.input) throw new Error('Execution input must be the final message in its fixed Transcript range');
  return Array.from({ length: range.length - 1 }, (_, offset) => {
    const index = range.start + offset;
    return Object.freeze({ index, message: range.read(index) });
  });
}
