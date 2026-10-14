import { decisionInputCodec, checkLeafResult } from '../operations/checkpoint.js';
import { OperationDefinition, cloneCheckpointValue, type CheckpointCodec, type InvocationWorkView, type InvocationCheckpointDefinition, type OperationContextView } from '@capix/server-runtime';
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
  readonly checkpoint: InvocationCheckpointDefinition<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision>> = {
    key: 'observer.function-decision',
    version: 1,
    input: decisionInputCodec,
    output: proposalCodec,
    points: { result: { state: proposalCodec, check: checkLeafResult, resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, result: ConversationDecision) => result } } },
  };

  constructor(decide: (input: ConversationDecisionInput, signal: AbortSignal) => ConversationDecision | Promise<ConversationDecision>) {
    super();
    this.run = {
      requires: {},
      execute: async (context: OperationContextView<ConversationDecisionInput, ConversationDecision>, invocation: InvocationWorkView<ConversationDecisionInput, ConversationDecision, OperationContextView<ConversationDecisionInput, ConversationDecision>>) => {
        const result = await decide(context.currentInput, context.signal);
        invocation.checkpoint?.save('result', result);
        return result;
      },
    };
  }
}
