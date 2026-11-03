import type { ModelProvider, ModelReply, ModelRequest } from '@capix/model-provider';
import { ResourceOffer, type ResourceOperation } from '@capix/resources';
import { InvocationCancelled } from '@capix/server-runtime';
import { requireText } from './text.js';

/** Complete provider replies remain visible; each business node decides what to accept. */
export const CompletionResource = new ResourceOffer({
  name: 'conversation.completion',
  methods: {
    async complete(model: ModelProvider, request: ModelRequest, operation: ResourceOperation): Promise<ModelReply> {
      try {
        return await model.complete(request, { signal: operation.signal });
      } catch (error) {
        if (operation.signal?.aborted && error === operation.signal.reason) throw new InvocationCancelled(operation.signal);
        throw error;
      }
    },
  },
  observation: {
    methods: { complete: { input: (request) => ({ messages: request.messages.length, responseFormat: request.responseFormat }), output: (reply) => ({ model: reply.model, finishReason: reply.finishReason, usage: reply.usage }) } },
  },
});

/** This service accepts only complete, nonblank text; it does not repair or retry model output. */
export function requireCompletionText(reply: ModelReply): string {
  if (!reply || reply.finishReason !== 'stop') throw new Error('Model completion did not finish normally');
  return requireText(reply.text, 'Model completion text');
}
