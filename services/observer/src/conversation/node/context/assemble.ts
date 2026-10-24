import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { answerMessageContextSchema, checkLeafResult } from '../../group/checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { Message } from '@capix/protocol';
import { type NodeWork, Node, checkpointPoint } from '@capix/server-runtime';

/** Fixed material captured by the parent after active-content maintenance. */
export interface AnswerMessageContext {
  readonly message: Readonly<Message>;
  readonly selectedMessages: readonly { readonly index: number; readonly message: Readonly<Message> }[];
}

const contextCodec = checkpointCodec<AnswerMessageContext>(answerMessageContextSchema);

/** Check the supplied material; never re-read a mutable Transcript or active index. */
export class AssembleAnswerContext extends Node<AnswerMessageContext, AnswerMessageContext> {
  private readonly resultPoint;

  constructor() {
    super();

    this.resultPoint = checkpointPoint<'node', AnswerMessageContext, AnswerMessageContext>()({
      name: 'result',
      state: contextCodec,
      references: {},
      check: (result, facts) => {
        checkLeafResult(facts);
        if (!isEqual(result, facts.input)) throw new Error('Fixed message material changed during assembly');
      },
      resume: { run: (_work, result) => result },
    });

    this.setDefinition({ observation: [invocationRecording()], name: 'assembleContext', label: '确认消息材料', source: 'services/observer/src/conversation/node/context/assemble.ts · AssembleAnswerContext', callee: 'processing', checkpoint: { key: 'observer.assemble-answer-context', version: 2, input: contextCodec, output: contextCodec, points: [this.resultPoint] }, deps: {}, run: this.execute.bind(this) });
  }

  private execute(work: NodeWork<AnswerMessageContext, AnswerMessageContext>): AnswerMessageContext {
    const parsed = answerMessageContextSchema.parse(work.input);
    const result = Object.freeze({ message: Object.freeze(parsed.message), selectedMessages: Object.freeze(parsed.selectedMessages.map((item) => Object.freeze({ index: item.index, message: Object.freeze(item.message) }))) });
    work.checkpoint?.({ point: this.resultPoint, state: result, refs: {} });
    return result;
  }
}
