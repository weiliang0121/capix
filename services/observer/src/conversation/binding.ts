import { Initializer, assembleRuntime, type ChangeCapture, type InvocationControls, type ExecutionInvocationCallbacks, type ObservationInstallation, type ProgressChannel, type InvocationProgress } from '@capix/server-runtime';
import { TranscriptRangeRef, type Transcript, type Memories, type SelectionUsage, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import { isFunction } from 'es-toolkit/predicate';
import type { ModelSettings, InvocationEvent, Message, GenerationOutput } from '@capix/protocol';
import type { ModelProvider, ModelInitialization } from './model/types.js';
import { ConversationRuntimeDefinition } from './definition.js';
import { conversationProviders, type ConversationExecutionResources } from './resources.js';
import type { ConversationProgress } from './progress.js';
import { validateSettings } from '../assembly/settings.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  /** One passive channel for this submission. Reusing it explicitly shares its failure state. */
  progress?: ProgressChannel<ConversationProgress>;
  /** Optional passive REOA metadata; a failed activity consumer does not disable content progress. */
  activity?: ProgressChannel<InvocationProgress>;
  executionCallbacks?: ExecutionInvocationCallbacks<Readonly<Message>, GenerationOutput, ConversationExecutionResources>;
}
export interface ConversationEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
}

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindConversation(definition: ConversationRuntimeDefinition, entities: ConversationEntities, provider: ModelInitialization, observation: { observations?: readonly ObservationInstallation[]; changes?: ChangeCapture<InvocationEvent> } = {}) {
  const model = new Initializer<ModelProvider>(isFunction(provider) ? provider : () => provider);
  const source = (options: ConversationRunOptions, kind: 'input' | 'answer', selected: boolean) => ({
    ...entities,
    settings: Object.freeze({ ...options.settings }),
    model,
    messageProgress:
      selected && options.progress
        ? {
            receive: (range: TranscriptAppendProgress): undefined => {
              options.progress!.publish({ kind, range });
            },
          }
        : undefined,
  });
  return assembleRuntime(definition, {
    ...observation,
    providers: conversationProviders,
    source: {
      validate: (options: ConversationRunOptions) => {
        validateSettings(options.settings);
      },
      entry: (_input: unknown, options: ConversationRunOptions, current) => source(options, 'input', current === definition.executionDefinition),
      capture: (_input, options: ConversationRunOptions, current) => ({ ...source(options, 'answer', current === definition.executionDefinition), transcriptRange: new TranscriptRangeRef(entities.transcript, entities.transcript.activeStart, entities.transcript.length) }),
      callbacks: (current, options) => (current === definition.executionDefinition ? options.executionCallbacks : undefined),
      progress: (_input, options) =>
        options.activity
          ? {
              receive: (fact): undefined => {
                options.activity!.publish(fact);
              },
            }
          : undefined,
      executionProgress: (current, options) =>
        current === definition.executionDefinition && options.progress
          ? {
              receive: (fact): undefined => {
                if (fact.kind === 'started' && fact.identity.level === 'execution') options.progress!.publish({ kind: 'execution', contextId: fact.identity.contextId });
              },
            }
          : undefined,
    },
  });
}
export type BoundConversationRuntime = ReturnType<typeof bindConversation>;
