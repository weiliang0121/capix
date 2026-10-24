import { type Resources, type Runner, callableHooks } from '@capix/server-runtime';
import { TranscriptResource, MemoryResource, SelectionUsageResource, type CapturedMemories } from '@capix/server-runtime/content';
import type { ModelInteractions } from './model/interactions.js';
import { ModelResource, ModelSettingsResource } from './model/resources.js';
import type { ConversationScene, ConversationStructure } from './scene.js';
import { FileResources, type FileResourceSource } from '../files/index.js';
import type { DocumentProcessingInput } from './group/document/process.js';
import type { CreateTextInput } from './node/files/create.js';
import { ActiveContentResource } from './content/resource.js';
import { ConversationMaterialUsageResource } from './content/usage.js';
import { ConversationTaskResource } from './decision/selection.js';
import type { ConversationBindingOptions, ConversationEntities, ConversationRunOptions } from './binding/contract.js';
import { ConversationCallCapture } from './binding/capture.js';
import { activityProgress, answerProgress, messageProgress, taskProgress } from './binding/progress.js';

export type { ConversationRunOptions, ConversationEntities, ConversationBindingOptions } from './binding/contract.js';
export type ConversationRunner = Runner<ConversationScene, ConversationRunOptions>;

/** Register entity supply and explicit call scopes; this does not build or start the scene. */
export function registerConversationResources(resources: Resources<ConversationRunOptions>, structure: ConversationStructure, registeredEntities: ConversationEntities, model: ModelInteractions, capabilities: ConversationBindingOptions = {}) {
  const entities = Object.freeze({ ...registeredEntities });
  const { scene, conversation, document, save } = structure;
  if (scene.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const capture = new ConversationCallCapture(scene, entities, Object.freeze({ ...capabilities }));

  resources.register(ActiveContentResource.read, entities.active);
  resources.register(ActiveContentResource.manage, entities.active);
  resources.register(ModelResource.create, model);
  resources.register(ModelResource.read, model);
  resources.register(MemoryResource.apply, entities.memories);
  resources.register(TranscriptResource.segmentation, entities.transcript);
  resources.register(ConversationMaterialUsageResource, { transcript: entities.transcript, selectionUsage: entities.selectionUsage });
  resources.register(SelectionUsageResource.record, entities.selectionUsage);

  // Input append belongs to the scene; its actual accepted range is the next scope's basis.
  resources.capture(scene, (_input, options) => ({ transcript: entities.transcript, progress: capture.inputProgress(options) })).register(TranscriptResource.append, (messages) => messages);

  // Capture once after the scene has accepted input. Children inherit these fixed values.
  const task = resources.capture(conversation, (accepted, options) => {
    const history = capture.captureTask(accepted, options);
    const restored = options.checkpointRun;
    const memorySnapshot: CapturedMemories | undefined = restored?.memories.items ? { memoriesId: entities.memories.id, sequence: restored.memories.sequence, items: restored.memories.items } : undefined;
    return {
      history,
      settings: capture.settings(options),
      memories: memorySnapshot ?? entities.memories,
      messages: { transcript: entities.transcript, progress: messageProgress('answer', options.progress) },
      tasks: { progress: taskProgress(options.progress, options.fileProgress) },
      files: entities.files ? { files: entities.files, constraint: accepted.fileTask, progress: options.fileProgress } : undefined,
    };
  });
  task
    .register(TranscriptResource.fixedRange, (supply) => supply.history)
    .register(ModelSettingsResource.snapshot, (supply) => supply.settings)
    .register(ModelSettingsResource.timeout, (supply) => supply.settings.timeoutMs)
    .register(MemoryResource.snapshot, (supply) => supply.memories)
    .register(TranscriptResource.append, (supply) => supply.messages)
    .register(ConversationTaskResource, (supply) => supply.tasks);
  if (scene.filesEnabled) {
    // Each resource keeps its own endpoint and scope check; the entity itself is shared.
    task.register(FileResources.inspect, fileSupply).register(FileResources.readText, fileSupply).register(FileResources.createText, fileSupply);
  }
  if (document)
    resources.refine(
      document,
      FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath),
    );
  if (save)
    resources.refine(
      save,
      FileResources.createText.refine((input: CreateTextInput) => input.path),
    );

  return {
    validate: (options: ConversationRunOptions) => capture.validate(options),
    hooks: [
      callableHooks(scene, { progress: (_input, options: ConversationRunOptions) => activityProgress(options.activity) }),
      callableHooks(conversation, {
        started: (_input, options: ConversationRunOptions) => capture.startedTask(options),
        output: (_input, options: ConversationRunOptions) => answerProgress(options.answerProgress),
      }),
    ],
  };
}

function fileSupply(supply: { readonly files?: FileResourceSource }): FileResourceSource {
  if (!supply.files) throw new Error('A configured file workspace is required');
  return supply.files;
}
