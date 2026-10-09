import { TranscriptResource } from '@capix-observer/runtime';
import type { HistoryResources } from '../../observer/resources.js';
import { isSafeInteger } from 'es-toolkit/compat';
import type { Selection } from '../../model/types.js';
import type { Message } from '@capix-observer/protocol';
import { type AttemptScope, AttemptDefinition } from '@capix-observer/runtime';

export interface AssembledContext {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { index: number; message: Readonly<Message> }[];
}

export class AssembleContext extends AttemptDefinition<Selection, AssembledContext, HistoryResources> {
  static readonly requires = Object.freeze({ history: TranscriptResource.fixedRange.request() });

  readonly name = 'assembleContext';
  readonly label = '组合消息';
  readonly source = 'services/observer/src/attempt/context/assemble.ts · AssembleContext';
  readonly callee = 'processing';

  readonly requires = AssembleContext.requires;

  execute(context: AttemptScope<Selection, AssembledContext, HistoryResources>): AssembledContext {
    const range = context.resources.values.history;
    if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
    const selectedMessages = context.currentInput.historyIndexes.map((index) => {
      if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
      return Object.freeze({ index, message: range.read(index) });
    });
    return Object.freeze({ message: range.read(range.end - 1), selectedMessages: Object.freeze(selectedMessages) });
  }
}
