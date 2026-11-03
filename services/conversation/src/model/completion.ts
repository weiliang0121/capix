import type { InteractionChannel, InteractionReference } from '@capix/interaction';
import type { ModelReply, ModelRequest } from '@capix/model-provider';
import { ResourceOffer, type ResourceOperation, type ResourcesOf } from '@capix/resources';
import { Group, Node } from '@capix/structure';
import { requireString } from '../text.js';
import { followModelFeedback, waitModelFeedback, type ModelFeedbackInput, type ModelProgressDelta, type ModelProgressInput } from './feedback.js';
import { ModelReplyPending } from './pending.js';
import { requireCompletionReply } from './completion-contract.js';

type CompletionChannel = InteractionChannel<ModelRequest, ModelReply, string>;

/** Start grants dispatch; feedback grants only consumption of a previously established reference. */
export const CompletionInteractionResource = Object.freeze({
  start: new ResourceOffer({
    name: 'conversation.completion.start',
    methods: {
      start(channel: CompletionChannel, request: ModelRequest) {
        return channel.start(request);
      },
    },
    observation: { methods: { start: { input: (request) => ({ messages: request.messages.length, stream: request.stream === true, responseFormat: request.responseFormat }), output: (reference) => reference } } },
  }),
  feedback: new ResourceOffer({
    name: 'conversation.completion.feedback',
    methods: {
      read(channel: CompletionChannel, reference: InteractionReference) {
        return channel.read(reference);
      },
      wait(channel: CompletionChannel, input: ModelFeedbackInput, operation: ResourceOperation) {
        return waitModelFeedback(channel, input, operation);
      },
      follow(channel: CompletionChannel, input: ModelProgressInput, operation: ResourceOperation<ModelProgressDelta>) {
        return followModelFeedback(channel, input, operation);
      },
    },
    observation: {
      methods: {
        read: { input: (reference) => reference, output: (reply) => ({ kind: reply.kind }) },
        wait: { input: (input) => input, output: (reply) => ({ kind: reply.kind }) },
        follow: { input: (input) => input, output: (reply) => ({ kind: reply.kind }) },
      },
    },
  }),
});

/** A separate sender lets a host receive the reference before starting a local read. */
export function createCompletionStartNode() {
  const deps = { requests: CompletionInteractionResource.start.request() };
  return new Node<ModelRequest, InteractionReference, ResourcesOf<typeof deps>>({
    name: 'start-completion-request',
    deps,
    run: (work) => work.resources.requests.start(work.input),
  });
}

/** Reading preserves the full reply, including unsuccessful finish reasons and empty text. */
export function createCompletionReplyNode(waitMs = 30_000) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new RangeError('Completion reply wait must be a nonnegative timer duration');
  const deps = { feedback: CompletionInteractionResource.feedback.request() };
  return new Node<InteractionReference, ModelReply, ResourcesOf<typeof deps>, string>({
    name: 'read-completion-reply',
    deps,
    output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Completion preview') },
    async run(work) {
      const reference = Object.freeze({ id: work.input.id, contract: work.input.contract });
      const reply = await work.resources.feedback.follow({ reference, waitMs }, { delta: (item) => work.output.emit(item.value) });
      if (reply.kind === 'received') return reply.feedback.payload;
      if (reply.kind === 'unavailable') throw reply.error;
      throw new ModelReplyPending(reference);
    },
  });
}

/** No hidden retry or independent lifetime is introduced by composing the send and read nodes. */
export function createInteractionCompletion(options: { readonly waitMs?: number } = {}) {
  const send = createCompletionStartNode();
  const read = createCompletionReplyNode(options.waitMs);
  const completion = new Group<ModelRequest, ModelReply, {}, string>({ name: 'interaction-completion', output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Completion preview') } }).add({ send, read });
  completion.run = async (work) => {
    const reference = await work.children.send.invoke(work.input);
    return work.children.read.invoke(reference, { delta: (value) => work.output.emit(value) });
  };
  return completion;
}
