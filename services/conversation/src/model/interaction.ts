import type { Message } from '@capix/protocol';
import type { InteractionChannel, InteractionContract, InteractionReference } from '@capix/interaction';
import { ResourceOffer, type ResourceOperation } from '@capix/resources';
import { requireString, requireText } from '../text.js';
import { followModelFeedback, waitModelFeedback, type ModelFeedbackInput, type ModelProgressInput, type ModelProgressDelta } from './feedback.js';

export type ModelMessages = readonly Readonly<Message>[];

/** The external exchange stores only fixed request/reply data, never a Work or output callback. */
export const TextModelInteraction: InteractionContract<ModelMessages, string, string> = Object.freeze({
  key: 'conversation.text-model.v1',
  request(value: unknown): ModelMessages {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('Model request requires messages');
    return Object.freeze(
      Array.from(value, (message: unknown) => {
        if (!message || typeof message !== 'object' || !('role' in message) || !('content' in message) || Object.keys(message).length !== 2 || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') throw new TypeError('Model request requires user/assistant text messages');
        return Object.freeze({ role: message.role, content: message.content });
      }),
    );
  },
  reply: (value: unknown) => requireText(value, 'Model answer'),
  progress: (value: unknown) => requireString(value, 'Model progress'),
});

type ModelChannel = InteractionChannel<ModelMessages, string, string>;

/** Starting and reading have separate grants. A reader can never send a replacement request. */
export const ModelInteractionResource = Object.freeze({
  start: new ResourceOffer({
    name: 'conversation.model.start',
    methods: {
      start(channel: ModelChannel, messages: ModelMessages) {
        return channel.start(messages);
      },
    },
    observation: { methods: { start: { input: (messages) => ({ messages: messages.length }), output: (reference) => reference } } },
  }),
  feedback: new ResourceOffer({
    name: 'conversation.model.feedback',
    methods: {
      read(channel: ModelChannel, reference: InteractionReference) {
        return channel.read(reference);
      },
      wait(channel: ModelChannel, input: ModelFeedbackInput, operation: ResourceOperation) {
        return waitModelFeedback(channel, input, operation);
      },
      follow(channel: ModelChannel, input: ModelProgressInput, operation: ResourceOperation<ModelProgressDelta>) {
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
