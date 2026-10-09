import { Initializer, assembleRuntime, TranscriptRangeRef, type Transcript, type Memories, type SelectionUsage, type Recorder, type ChangeCapture, type ExecutionOptions } from '@capix-observer/runtime';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelSettings, ConversationUpdate, InvocationEvent } from '@capix-observer/protocol';
import type { ModelProvider, ModelInitialization } from '../provider.js';
import { ObserverRuntimeDefinition } from './definition.js';
import { observerProviders } from './resources.js';
import { validateSettings } from '../settings.js';

export interface ObserverExecutionOptions extends ExecutionOptions {
  settings: ModelSettings;
  deliver?: (update: ConversationUpdate) => void;
}
export interface ObserverEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
}
const ignoreDelivery = (_update: ConversationUpdate): void => {};

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindObserver(definition: ObserverRuntimeDefinition, entities: ObserverEntities, provider: ModelInitialization, observation: { recorder?: Recorder; changes?: ChangeCapture<InvocationEvent> } = {}) {
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
    },
  });
}
export type ObserverRuntime = ReturnType<typeof bindObserver>;
