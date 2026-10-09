import { Initializer, assembleRuntime, TranscriptRangeRef, type Transcript, type Memories, type SelectionUsage, type ChangeCapture, type RuntimeCallOptions, type ExecutionCallbacks, type ObservationInstallation } from '@capix-observer/runtime';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelSettings, ConversationUpdate, InvocationEvent, Message, GenerationOutput } from '@capix-observer/protocol';
import type { ModelProvider, ModelInitialization } from '../provider.js';
import { ObserverRuntimeDefinition } from './definition.js';
import { observerProviders, type ObserverExecutionResources } from './resources.js';
import { validateSettings } from '../settings.js';

export interface ObserverExecutionOptions extends RuntimeCallOptions {
  settings: ModelSettings;
  deliver?: (update: ConversationUpdate) => void;
  execution?: ExecutionCallbacks<Readonly<Message>, GenerationOutput, ObserverExecutionResources>;
}
export interface ObserverEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
}
const ignoreDelivery = (_update: ConversationUpdate): void => {};

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindObserver(definition: ObserverRuntimeDefinition, entities: ObserverEntities, provider: ModelInitialization, observation: { observations?: readonly ObservationInstallation[]; changes?: ChangeCapture<InvocationEvent> } = {}) {
  const model = new Initializer<ModelProvider>(isFunction(provider) ? provider : () => provider);
  const source = (options: ObserverExecutionOptions) => ({ ...entities, settings: Object.freeze({ ...options.settings }), model, delivery: options.deliver ?? ignoreDelivery });
  return assembleRuntime(definition, {
    ...observation,
    providers: observerProviders,
    source: {
      validate: (options: ObserverExecutionOptions) => {
        validateSettings(options.settings);
      },
      entry: (_input: unknown, options: ObserverExecutionOptions) => source(options),
      capture: (_input, options: ObserverExecutionOptions) => ({ ...source(options), transcriptRange: new TranscriptRangeRef(entities.transcript, entities.transcript.activeStart, entities.transcript.length) }),
      callbacks: (_definition, options) => options.execution,
    },
  });
}
export type ObserverRuntime = ReturnType<typeof bindObserver>;
