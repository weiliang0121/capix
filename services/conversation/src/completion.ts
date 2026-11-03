import type { ModelProvider, ModelReply, ModelRequest } from '@capix/model-provider';
import { ResourceOffer, type ResourceOperation, type ResourcesOf } from '@capix/resources';
import { InvocationCancelled } from '@capix/server-runtime';
import { Node, type Group } from '@capix/structure';
import { requireString, requireText } from './text.js';
import { requireCompletionReply } from './model/completion-contract.js';

/** Complete provider replies remain visible; each business node decides what to accept. */
export const CompletionResource = new ResourceOffer({
  name: 'conversation.completion',
  methods: {
    async complete(model: ModelProvider, request: ModelRequest, operation: ResourceOperation<string>): Promise<ModelReply> {
      try {
        return await model.complete(request, { signal: operation.signal, ...(request.stream ? { emit: (delta: string) => operation.emit(requireString(delta, 'Model completion delta')) } : {}) });
      } catch (error) {
        if (operation.signal?.aborted && error === operation.signal.reason) throw new InvocationCancelled(operation.signal);
        throw error;
      }
    },
  },
  observation: {
    methods: { complete: { input: (request) => ({ messages: request.messages.length, responseFormat: request.responseFormat, stream: request.stream === true }), output: (reply) => ({ model: reply.model, finishReason: reply.finishReason, usage: reply.usage }) } },
  },
});

/** A concrete child owns its own model dependencies and request lifecycle. */
export type ConversationCompletion = Node<ModelRequest, ModelReply, any, string> | Group<ModelRequest, ModelReply, any, string>;

/** Direct completion uses the current invocation's signal and resource operation. */
export function createCompletionNode() {
  const deps = { model: CompletionResource.request() };
  return new Node<ModelRequest, ModelReply, ResourcesOf<typeof deps>, string>({
    name: 'complete-model-request',
    deps,
    output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Model completion delta') },
    run: (work) => work.resources.model.complete(work.input, { delta: (value) => work.output.emit(value) }),
  });
}

/** This service accepts only complete, nonblank text; it does not repair or retry model output. */
export function requireCompletionText(reply: ModelReply): string {
  if (!reply || reply.finishReason !== 'stop') throw new Error('Model completion did not finish normally');
  return requireText(reply.text, 'Model completion text');
}
