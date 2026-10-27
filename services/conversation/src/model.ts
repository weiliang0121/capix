import type { Message } from '@capix/protocol';
import { ResourceOffer, type ResourceOperation } from '@capix/resources';

/** A host-provided text capability. Provider configuration and credentials stay with the host. */
export interface TextModel {
  generate(messages: readonly Readonly<Message>[], controls: { readonly signal?: AbortSignal }): string | Promise<string>;
}

/** Direct resource operation; durable external exchanges remain a separate, optional capability. */
export const ModelResource = new ResourceOffer({
  name: 'conversation.model',
  methods: {
    generate(model: TextModel, messages: readonly Readonly<Message>[], operation: ResourceOperation) {
      return model.generate(messages, { signal: operation.signal });
    },
  },
  observation: {
    methods: { generate: { input: (messages) => ({ messages: messages.length }), output: (text) => ({ characters: typeof text === 'string' ? text.length : undefined }) } },
  },
});
