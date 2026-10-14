import { isEqual } from 'es-toolkit';
import { assembleRuntime, bindChildResources, type ChangeCapture, type InvocationControls, type ExecutionInvocationCallbacks, type ObservationInstallation, type ProgressChannel, type InvocationProgress, type CheckpointInstallation } from '@capix/server-runtime';
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
import type { AnswerProgress } from './operations/answer/stream.js';
import { validateSettings } from '../assembly/settings.js';
import { checkpointTranscriptFingerprint, validateConversationCheckpointContent, validateConversationCheckpointDeliveryContent, validateConversationCheckpointReceipt, validateConversationCheckpointHeads, type ConversationCheckpointRun, type ConversationCheckpointRuns } from './checkpoints.js';

export interface ConversationRunOptions extends InvocationControls {
  settings: ModelSettings;
  /** Host-only fixed construction basis; this does not replay submission notifications. */
  checkpointRun?: ConversationCheckpointRun;
  /** One passive channel for this submission. Reusing it explicitly shares its failure state. */
  progress?: ProgressChannel<ConversationProgress>;
  /** Optional passive REOA metadata; a failed activity consumer does not disable content progress. */
  activity?: ProgressChannel<InvocationProgress>;
  fileProgress?: ProgressChannel<FileProgress>;
  answerProgress?: ProgressChannel<AnswerProgress>;
  executionCallbacks?: ExecutionInvocationCallbacks<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>;
}
export interface ConversationEntities {
  transcript: Transcript;
  memories: Memories;
  selectionUsage: SelectionUsage;
  files?: WorkspaceFiles;
}

/** Bind independent entities to R. The resulting R is the sole business execution entry. */
export function bindConversation(definition: ConversationRuntimeDefinition, entities: ConversationEntities, model: ModelInteractions, capabilities: { observations?: readonly ObservationInstallation[]; changes?: ChangeCapture<InvocationEvent>; checkpoints?: CheckpointInstallation; checkpointRuns?: ConversationCheckpointRuns; conversationId?: string } = {}) {
  if (definition.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const captures = new WeakMap<ConversationRunOptions, { input?: TranscriptAppendProgress; transcript?: ConversationCheckpointRun['transcript'] }>();
  if (capabilities.checkpointRuns && (!capabilities.checkpoints || !capabilities.conversationId)) throw new Error('Checkpoint run association requires a conversation and checkpoint store');
  const operations = definition.executionDefinition.operationDefinitions;
  const source = (options: ConversationRunOptions, kind: 'input' | 'answer', selected: boolean) => ({
    ...entities,
    ...(options.checkpointRun?.memories.items ? { memorySnapshot: { memoriesId: entities.memories.id, sequence: options.checkpointRun.memories.sequence, items: options.checkpointRun.memories.items } } : {}),
    settings: Object.freeze({ ...(options.checkpointRun?.settings ?? options.settings) }),
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
      selected && (options.progress || (capabilities.checkpointRuns && kind === 'input'))
        ? {
            receive: (range: TranscriptAppendProgress): undefined => {
              if (kind === 'input') {
                const capture = captures.get(options);
                if (capture) capture.input = range;
              }
              options.progress?.publish({ kind, range });
            },
          }
        : undefined,
  });
  return assembleRuntime(definition, {
    observations: capabilities.observations,
    changes: capabilities.changes,
    checkpoints: capabilities.checkpoints,
    childResources: [...(operations.document ? [bindChildResources(operations.document, [FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath)])] : []), ...(operations.save ? [bindChildResources(operations.save, [FileResources.createText.refine((input: CreateTextInput) => input.path)])] : [])],
    providers: [...conversationProviders, ...(definition.filesEnabled ? conversationFileProviders : [])],
    source: {
      validate: (options: ConversationRunOptions) => {
        validateSettings(options.settings);
        if (options.checkpointRun) {
          if (options.checkpointRun.conversationId !== capabilities.conversationId) throw new Error('Checkpoint belongs to another conversation');
          const known = capabilities.checkpointRuns?.read(options.checkpointRun.conversationId, options.checkpointRun.rootContextId);
          if (!known || !isEqual(known, options.checkpointRun)) throw new Error('Checkpoint run is not registered in this conversation');
          const configuration = { files: definition.filesEnabled, ...(definition.filesEnabled ? { fileScope: entities.files!.checkpointScope } : {}), maxDecisionSteps: definition.executionDefinition.maxDecisionSteps, customDecision: definition.customDecision };
          if (configuration.customDecision || !isEqual(configuration, known.configuration)) throw new Error('Checkpoint conversation declaration configuration has changed or is not restorable');
          const executionHead = capabilities.checkpoints?.store.read(known.executionContextId);
          validateConversationCheckpointHeads(known, capabilities.checkpoints?.store.read(known.rootContextId), executionHead);
          const validateContent = executionHead?.delivery?.status === 'succeeded' ? validateConversationCheckpointDeliveryContent : validateConversationCheckpointContent;
          validateContent(options.checkpointRun, entities.transcript, entities.memories, capabilities.checkpoints?.store);
          validateConversationCheckpointReceipt(options.checkpointRun, entities.transcript, executionHead);
        }
        captures.set(options, {});
      },
      entry: (_input: unknown, options: ConversationRunOptions, current) => source(options, 'input', current === definition.executionDefinition),
      capture: (input, options: ConversationRunOptions, current) => {
        const selected = current === definition.executionDefinition;
        const accepted = selected ? (input as AcceptedConversationInput) : undefined;
        const restored = options.checkpointRun;
        const range = new TranscriptRangeRef(entities.transcript, restored?.transcript.start ?? entities.transcript.activeStart, restored?.transcript.end ?? entities.transcript.length);
        if (selected && capabilities.checkpointRuns && !restored) {
          const capture = captures.get(options);
          if (!capture?.input) throw new Error('Checkpoint construction requires the actual accepted input range');
          capture.transcript = Object.freeze({ transcriptId: entities.transcript.id, start: range.start, end: range.end, revision: entities.transcript.revision, fingerprint: checkpointTranscriptFingerprint(entities.transcript, Math.min(range.start, capture.input.start), range.end) });
        }
        return { ...source(options, 'answer', selected), fileTask: accepted?.fileTask, transcriptRange: range };
      },
      callbacks: (current, options) =>
        current === definition.executionDefinition
          ? {
              accepted: options.executionCallbacks?.accepted,
              started: (context, invocation) => {
                if (capabilities.checkpointRuns) {
                  const capture = captures.get(options);
                  const rootContextId = invocation.identity.parentContextId;
                  if (!capture?.input || !capture.transcript || !rootContextId) throw new Error('Checkpoint construction basis is incomplete');
                  capabilities.checkpointRuns.register({ conversationId: capabilities.conversationId!, rootContextId, executionContextId: context.id, settings: options.settings, configuration: { files: definition.filesEnabled, ...(definition.filesEnabled ? { fileScope: entities.files!.checkpointScope } : {}), maxDecisionSteps: definition.executionDefinition.maxDecisionSteps, customDecision: definition.customDecision }, transcript: capture.transcript, input: capture.input, memories: { id: entities.memories.id, sequence: entities.memories.sequence, items: entities.memories.snapshot() } });
                }
                options.executionCallbacks?.started?.(context, invocation);
              },
            }
          : undefined,
      progress: (_input, options) =>
        options.activity
          ? {
              receive: (fact): undefined => {
                options.activity!.publish(fact);
              },
            }
          : undefined,
      executionOutput: (current, options) =>
        current === definition.executionDefinition && options.answerProgress
          ? {
              receive: (event): undefined => {
                if (event.kind === 'delta') options.answerProgress!.publish(event.delta as AnswerProgress);
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
