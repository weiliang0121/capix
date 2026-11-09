import { Interactions, type InteractionRegistration } from '@weiliang0121/capix-interaction';
import type { ModelProvider, ModelRequest, ModelReply } from '@weiliang0121/capix-model-provider';
import { CompletionInteraction } from '../model/completion-contract.js';

/** Host-owned sending: a local call can stop reading without stopping this request. */
export function createConversationInteractions(model: ModelProvider, persistence?: InteractionRegistration<ModelRequest, ModelReply, string>['persistence']) {
  return new Interactions().register(CompletionInteraction, {
    persistence,
    send(request, { publish }) {
      return model.complete(request, request.stream ? { emit: (delta) => void publish(delta) } : {});
    },
  });
}
