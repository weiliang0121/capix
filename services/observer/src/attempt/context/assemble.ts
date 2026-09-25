import { isSafeInteger } from 'es-toolkit/compat';
import type { Selection } from '../../model/types.js';
import type { Message } from '@capix-observer/protocol';
import { type AttemptContext, Attempt } from '@capix-observer/runtime';

export interface AssembledContext {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { index: number; message: Readonly<Message> }[];
}

export class AssembleContext extends Attempt<Selection, AssembledContext> {
  readonly name = 'assembleContext';
  readonly label = '组合消息';
  readonly source = 'services/observer/src/attempt/context/assemble.ts · AssembleContext';
  readonly callee = 'processing';

  protected execute(context: AttemptContext<Selection, AssembledContext>): AssembledContext {
    const execution = this.runtime.getExecutionContext(context);
    const range = execution.transcriptRange;
    if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
    const selectedMessages = context.currentInput.historyIndexes.map((index) => {
      if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
      return Object.freeze({ index, message: range.read(index) });
    });
    return Object.freeze({ message: execution.input as Readonly<Message>, selectedMessages: Object.freeze(selectedMessages) });
  }
}
