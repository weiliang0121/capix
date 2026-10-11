import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { ConversationDecision, ConversationDecisionInput } from './types.js';

/** A deterministic policy uses the same child delivery contract as a model-backed decision. */
export class FunctionConversationDecisionDefinition extends OperationDefinition<ConversationDecisionInput, ConversationDecision> {
  readonly name = 'conversationDecision';
  readonly label = '决定下一步';
  readonly source = 'services/observer/src/conversation/decision/function.ts · FunctionConversationDecisionDefinition';
  readonly observation = [invocationRecording()];
  readonly run;

  constructor(decide: (input: ConversationDecisionInput, signal: AbortSignal) => ConversationDecision | Promise<ConversationDecision>) {
    super();
    this.run = { requires: {}, execute: (context: OperationContextView<ConversationDecisionInput, ConversationDecision>) => decide(context.currentInput, context.signal) };
  }
}
