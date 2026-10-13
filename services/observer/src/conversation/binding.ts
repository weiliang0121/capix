import { assembleRuntime, bindChildResources, type ChangeCapture, type InvocationControls, type ExecutionInvocationCallbacks, type ObservationInstallation, type ProgressChannel, type InvocationProgress } from '@capix/server-runtime';
import { TranscriptRangeRef, type Transcript, type Memories, type SelectionUsage, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import type { ModelSettings, InvocationEvent, GenerationOutput, ConversationTask } from '@capix/protocol';
import type { ModelInteractions } from './model/interactions.js';
import { ConversationRuntimeDefinition } from './definition.js';
import { conversationProviders, conversationFileProviders, type ConversationExecutionResources } from './resources.js';
import type { ConversationProgress } from './progress.js';
import type { AcceptedConversationInput } from './accept.js';
import { FileResources, type WorkspaceFiles, type FileProgress } from '../files/index.js';
import type { DocumentProcessingInput } from './operations/document/process.js';
import type { CreateTextInput } from './attempt/files/create.js';
import { validateSettings } from '../assembly/settings.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  /** One passive channel for this submission. Reusing it explicitly shares its failure state. */
  progress?: ProgressChannel<ConversationProgress>;
  /** Optional passive REOA metadata; a failed activity consumer does not disable content progress. */
  activity?: ProgressChannel<InvocationProgress>;
  fileProgress?: ProgressChannel<FileProgress>;
  executionCallbacks?: ExecutionInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>;
}
export interface ConversationEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
  files?: WorkspaceFiles;
}

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindConversation(definition: ConversationRuntimeDefinition, entities: ConversationEntities, model: ModelInteractions, observation: { observations?: readonly ObservationInstallation[]; changes?: ChangeCapture<InvocationEvent> } = {}) {
  if (definition.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const operations = definition.executionDefinition.operationDefinitions;
  const source = (options: ConversationRunOptions, kind: 'input' | 'answer', selected: boolean) => ({
    ...entities,
    settings: Object.freeze({ ...options.settings }),
    model,
    fileProgress: selected ? options.fileProgress : undefined,
    taskProgress: selected
      ? {
          receive: (task: ConversationTask): undefined => {
            options.progress?.publish({ kind: 'task', task });
            if (task.kind === 'file' && task.task.output) options.fileProgress?.publish({ kind: 'requested', path: task.task.output.path });
          },
        }
      : undefined,
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
    childResources: [...(operations.document ? [bindChildResources(operations.document, [FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath)])] : []), ...(operations.save ? [bindChildResources(operations.save, [FileResources.createText.refine((input: CreateTextInput) => input.path)])] : [])],
    providers: [...conversationProviders, ...(definition.filesEnabled ? conversationFileProviders : [])],
    source: {
      validate: (options: ConversationRunOptions) => {
        validateSettings(options.settings);
      },
      entry: (_input: unknown, options: ConversationRunOptions, current) => source(options, 'input', current === definition.executionDefinition),
      capture: (input, options: ConversationRunOptions, current) => {
        const selected = current === definition.executionDefinition;
        const accepted = selected ? (input as AcceptedConversationInput) : undefined;
        return { ...source(options, 'answer', selected), fileTask: accepted?.fileTask, transcriptRange: new TranscriptRangeRef(entities.transcript, entities.transcript.activeStart, entities.transcript.length) };
      },
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
