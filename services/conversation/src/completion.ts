import { modelReplyText, type ModelProvider, type ModelReply, type ModelRequest } from '@capix/model-provider';
import { ResourceOffer, type ResourceOperation, type ResourcesOf } from '@capix/resources';
import { InvocationCancelled } from '@capix/server-runtime';
import { Node, checkpointPoint, type Group } from '@capix/structure';
import { requireString, requireText } from './text.js';
import { requireCompletionReply } from './model/completion-contract.js';
import { ModelCompletionIncomplete } from './model/incomplete.js';
import { modelReplyCodec, modelRequestCodec } from './recovery/model-codecs.js';

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
    methods: { complete: { input: (request) => ({ messages: request.messages.length, responseFormat: request.responseFormat, stream: request.stream === true }), output: (reply) => ({ model: reply.model, termination: reply.termination, usage: reply.usage }) } },
  },
});

/** A concrete child owns its own model dependencies and request lifecycle. */
export type ConversationCompletion = Node<ModelRequest, ModelReply, any, string> | Group<ModelRequest, ModelReply, any, string>;

/** Direct completion uses the current invocation's signal and resource operation. */
export function createCompletionNode() {
  const deps = { model: CompletionResource.request() };
  const completed = checkpointPoint<'node', ModelRequest, ModelReply, string>()({
    name: 'completed',
    state: modelReplyCodec,
    references: {},
    resume: { run: (_work, reply) => reply },
  });
  return new Node<ModelRequest, ModelReply, ResourcesOf<typeof deps>, string>({
    name: 'complete-model-request',
    deps,
    output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Model completion delta') },
    checkpoint: { key: 'conversation.direct-completion', version: 2, input: modelRequestCodec, output: modelReplyCodec, points: [completed] },
    async run(work) {
      const reply = await work.resources.model.complete(work.input, { delta: (value) => work.output.emit(value) });
      work.checkpoint?.({ point: completed, state: reply, refs: {} });
      return reply;
    },
  });
}

/** This service accepts only complete, nonblank text; it does not repair or retry model output. */
export function requireCompletionText(reply: ModelReply, maxTokens?: number): string {
  if (!reply || reply.termination.kind !== 'completed' || reply.termination.reason !== 'stop') throw new ModelCompletionIncomplete(reply?.termination.reason ?? 'unknown', maxTokens);
  return requireText(modelReplyText(reply), 'Model completion text');
}
