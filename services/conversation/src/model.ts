import type { Message } from '@capix/protocol';
import { ResourceOffer, type ResourceOperation } from '@capix/resources';
import { InvocationCancelled } from '@capix/server-runtime';
import { requireString } from './text.js';

/** A host-provided text capability. Provider configuration and credentials stay with the host. */
export interface TextModel {
  generate(messages: readonly Readonly<Message>[], controls: { readonly signal?: AbortSignal; readonly emit?: (delta: string) => void }): string | Promise<string>;
}

/** Direct resource operation; durable external exchanges remain a separate, optional capability. */
export const ModelResource = new ResourceOffer({
  name: 'conversation.model',
  methods: {
    async generate(model: TextModel, messages: readonly Readonly<Message>[], operation: ResourceOperation<string>) {
      try {
        return await model.generate(messages, { signal: operation.signal, emit: (delta) => operation.emit(requireString(delta, 'Model delta')) });
      } catch (error) {
        if (operation.signal?.aborted && error === operation.signal.reason) throw new InvocationCancelled(operation.signal);
        throw error;
      }
    },
  },
  observation: {
    methods: { generate: { input: (messages) => ({ messages: messages.length }), output: (text) => ({ characters: typeof text === 'string' ? text.length : undefined }) } },
  },
});
