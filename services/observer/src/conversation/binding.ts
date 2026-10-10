import { Initializer, assembleRuntime, type ChangeCapture, type InvocationControls, type ExecutionInvocationCallbacks, type ObservationInstallation } from '@capix/server-runtime';
import { TranscriptRangeRef, type Transcript, type Memories, type SelectionUsage } from '@capix/server-runtime/content';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelSettings, ConversationUpdate, InvocationEvent, Message, GenerationOutput } from '@capix/protocol';
import type { ModelProvider, ModelInitialization } from './model/types.js';
import { ConversationRuntimeDefinition } from './definition.js';
import { conversationProviders, type ConversationExecutionResources } from './resources.js';
import { validateSettings } from '../assembly/settings.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  deliver?: (update: ConversationUpdate) => void;
  executionCallbacks?: ExecutionInvocationCallbacks<Readonly<Message>, GenerationOutput, ConversationExecutionResources>;
}
export interface ConversationEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
}
const ignoreDelivery = (_update: ConversationUpdate): void => {};

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindConversation(definition: ConversationRuntimeDefinition, entities: ConversationEntities, provider: ModelInitialization, observation: { observations?: readonly ObservationInstallation[]; changes?: ChangeCapture<InvocationEvent> } = {}) {
  const model = new Initializer<ModelProvider>(isFunction(provider) ? provider : () => provider);
  const source = (options: ConversationRunOptions) => ({ ...entities, settings: Object.freeze({ ...options.settings }), model, delivery: options.deliver ?? ignoreDelivery });
  return assembleRuntime(definition, {
    ...observation,
    providers: conversationProviders,
    source: {
      validate: (options: ConversationRunOptions) => {
        validateSettings(options.settings);
      },
      entry: (_input: unknown, options: ConversationRunOptions) => source(options),
      capture: (_input, options: ConversationRunOptions) => ({ ...source(options), transcriptRange: new TranscriptRangeRef(entities.transcript, entities.transcript.activeStart, entities.transcript.length) }),
      callbacks: (_definition, options) => options.executionCallbacks,
    },
  });
}
export type BoundConversationRuntime = ReturnType<typeof bindConversation>;
