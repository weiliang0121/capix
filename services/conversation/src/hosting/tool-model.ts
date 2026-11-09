import { Interactions, type InteractionRegistration } from '@weiliang0121/capix-interaction';
import type { ModelProvider, ModelRequest, ModelReply } from '@weiliang0121/capix-model-provider';
import { CompletionInteraction } from '../model/completion-contract.js';
import { resolveToolBudgets, assertToolReplyBytes, type ToolByteBudgets } from '../tools/budget.js';

/** The independent sender enforces reply size before Interaction persists a successful reply. */
export function createToolConversationInteractions(model: ModelProvider, persistence: InteractionRegistration<ModelRequest, ModelReply, string>['persistence'], budgets?: Partial<ToolByteBudgets>) {
  if (typeof model.inspectRequest !== 'function') throw new TypeError('Tool host requires provider request inspection');
  const fixed = resolveToolBudgets(budgets);
  return new Interactions().register(CompletionInteraction, {
    persistence,
    async send(request) {
      const reply = await model.complete(request);
      assertToolReplyBytes(reply, fixed);
      return reply;
    },
  });
}
