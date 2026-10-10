import { invocationRecording } from '@capix/server-runtime/recording';
import { TranscriptResource } from '@capix/server-runtime/content';
import type { HistoryResources } from '../../resources.js';
import { isSafeInteger } from 'es-toolkit/compat';
import type { Selection } from '../../model/types.js';
import type { Message } from '@capix/protocol';
import { type AttemptContextView, AttemptDefinition } from '@capix/server-runtime';

export interface AnswerMessageContext {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { index: number; message: Readonly<Message> }[];
}

export class AssembleAnswerContextDefinition extends AttemptDefinition<Selection, AnswerMessageContext, HistoryResources> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({ history: TranscriptResource.fixedRange.request() });

  readonly name = 'assembleContext';
  readonly label = '组合消息';
  readonly source = 'services/observer/src/conversation/attempt/context/assemble.ts · AssembleAnswerContextDefinition';
  readonly callee = 'processing';

  readonly run = { requires: AssembleAnswerContextDefinition.requires, execute: this.execute.bind(this) };

  private execute(context: AttemptContextView<Selection, AnswerMessageContext, HistoryResources>): AnswerMessageContext {
    const range = context.resources.values.history;
    if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
    const selectedMessages = context.currentInput.historyIndexes.map((index) => {
      if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
      return Object.freeze({ index, message: range.read(index) });
    });
    return Object.freeze({ message: range.read(range.end - 1), selectedMessages: Object.freeze(selectedMessages) });
  }
}
