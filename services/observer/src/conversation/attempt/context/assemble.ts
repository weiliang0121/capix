import { z } from 'zod';
import { checkpointCodec } from '../../checkpoint.js';
import { selectionCodec, messageSchema, checkLeafResult } from '../../operations/checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import { TranscriptResource } from '@capix/server-runtime/content';
import type { HistoryResources } from '../../resources.js';
import { isSafeInteger } from 'es-toolkit/compat';
import type { Selection } from '../../model/types.js';
import type { Message } from '@capix/protocol';
import { type CheckpointCodec, type AttemptWork, type InvocationCheckpointDefinition, AttemptDefinition, checkpointPoint } from '@capix/server-runtime';

export interface AnswerMessageContext {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { index: number; message: Readonly<Message> }[];
}

const contextCodec: CheckpointCodec<AnswerMessageContext> = checkpointCodec(z.strictObject({ message: messageSchema, selectedMessages: z.array(z.strictObject({ index: z.int().nonnegative(), message: messageSchema })) }));

export class AssembleAnswerContextDefinition extends AttemptDefinition<Selection, AnswerMessageContext, HistoryResources> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({ history: TranscriptResource.fixedRange.request() });

  readonly name = 'assembleContext';
  readonly label = '组合消息';
  readonly source = 'services/observer/src/conversation/attempt/context/assemble.ts · AssembleAnswerContextDefinition';
  readonly callee = 'processing';

  private readonly resultPoint = checkpointPoint<'attempt', Selection, AnswerMessageContext>()({ name: 'result', state: contextCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  readonly checkpoint: InvocationCheckpointDefinition<Selection, AnswerMessageContext, 'attempt'> = { key: 'observer.assemble-answer-context', version: 1, input: selectionCodec, output: contextCodec, points: [this.resultPoint] };
  readonly run = { requires: AssembleAnswerContextDefinition.requires, execute: this.execute.bind(this) };

  private execute(work: AttemptWork<Selection, AnswerMessageContext, HistoryResources>): AnswerMessageContext {
    const range = work.resources.history;
    if (!range || range.length === 0) throw new Error('Execution Transcript range is required');
    const selectedMessages = work.input.historyIndexes.map((index) => {
      if (!isSafeInteger(index) || index < range.start || index >= range.end - 1) throw new RangeError('Selected message is outside the execution history');
      return Object.freeze({ index, message: range.read(index) });
    });
    const result = Object.freeze({ message: range.read(range.end - 1), selectedMessages: Object.freeze(selectedMessages) });
    work.checkpoint?.save(this.resultPoint, result, {});
    return result;
  }
}
