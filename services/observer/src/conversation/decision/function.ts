import { decisionInputCodec, checkLeafResult } from '../operations/checkpoint.js';
import { OperationDefinition, cloneCheckpointValue, type CheckpointCodec, checkpointPoint, type OperationWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { ConversationDecision, ConversationDecisionInput } from './types.js';

// The E acceptance contract, not this optional persistence port, decides whether a proposal is executable.
const proposalCodec: CheckpointCodec<ConversationDecision> = { encode: cloneCheckpointValue, decode: (value) => cloneCheckpointValue(value) as unknown as ConversationDecision };

/** A deterministic policy uses the same child delivery contract as a model-backed decision. */
export class FunctionConversationDecisionDefinition extends OperationDefinition<ConversationDecisionInput, ConversationDecision> {
  readonly name = 'conversationDecision';
  readonly label = '决定下一步';
  readonly source = 'services/observer/src/conversation/decision/function.ts · FunctionConversationDecisionDefinition';
  readonly observation = [invocationRecording()];
  readonly run;
  readonly resultPoint = checkpointPoint<'operation', ConversationDecisionInput, ConversationDecision>()({ name: 'result', state: proposalCodec, references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { execute: (_work, result) => result } });
  readonly checkpoint: InvocationCheckpointDefinition<ConversationDecisionInput, ConversationDecision, 'operation'> = {
    key: 'observer.function-decision',
    version: 2,
    input: decisionInputCodec,
    output: proposalCodec,
    points: [this.resultPoint],
  };

  constructor(decide: (input: ConversationDecisionInput, signal: AbortSignal) => ConversationDecision | Promise<ConversationDecision>) {
    super();
    this.run = {
      requires: {},
      execute: async (work: OperationWork<ConversationDecisionInput, ConversationDecision>) => {
        const result = await decide(work.input, work.signal);
        work.checkpoint?.save(this.resultPoint, result, {});
        return result;
      },
    };
  }
}
