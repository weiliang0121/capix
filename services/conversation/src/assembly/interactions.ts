import { Interactions } from '@capix/interaction';
import type { ModelProvider } from '@capix/model-provider';
import { CompletionInteraction } from '../model/completion-contract.js';

/** Host-owned sending: a local call can stop reading without stopping this request. */
export function createConversationInteractions(model: ModelProvider) {
  return new Interactions().register(CompletionInteraction, {
    send(request, { publish }) {
      return model.complete(request, request.stream ? { emit: (delta) => void publish(delta) } : {});
    },
  });
}
