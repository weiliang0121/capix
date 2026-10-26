import { type Resources } from '@capix/server-runtime';
import { Resource } from '@capix/resources';
import { TranscriptResource } from '@capix/transcript';
import { MemoryResource, type CapturedMemories } from '@capix/memory';
import { MessageUsageResource } from '@capix/measurement';
import type { ModelInteractions } from './model/interactions.js';
import { ModelResource, ModelSettingsResource } from './model/resources.js';
import type { ConversationStructure } from './structure.js';
import { FileResources, type FileResourceSource } from '../files/index.js';
import type { DocumentProcessingInput } from './group/document/process.js';
import type { CreateTextInput } from './node/files/create.js';
import { ActiveViewResource } from '@capix/observer-content';
import { ConversationMaterialUsageResource } from './content/usage.js';
import { ConversationTaskResource } from './decision/selection.js';
import type { AcceptedConversationInput } from './accept.js';
import type { ConversationEntities, ConversationRunOptions } from './binding/contract.js';
import type { ConversationCallCapture } from './binding/capture.js';
import { messageProgress, taskProgress } from './binding/progress.js';

/** Register supply only. Call validation, started hooks and output belong to the Runner. */
export function registerConversationResources(resources: Resources<ConversationRunOptions>, structure: ConversationStructure, registeredEntities: ConversationEntities, model: ModelInteractions, capture: ConversationCallCapture): void {
  const entities = Object.freeze({ ...registeredEntities });
  const { scene, conversation, document, save } = structure;
  capture.assertScope(scene, entities);
  if (scene.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');

  const active = new Resource(entities.active);
  const interactions = new Resource(model);
  const usage = new Resource(entities.messageUsage);
  resources.register(active, ActiveViewResource.read).register(active, ActiveViewResource.manage);
  resources.register(interactions, ModelResource.create).register(interactions, ModelResource.read);
  resources.register(new Resource(entities.memories), MemoryResource.apply);
  resources.register(new Resource(entities.transcript), TranscriptResource.segmentation);
  resources.register(new Resource({ transcript: entities.transcript, messageUsage: entities.messageUsage }), ConversationMaterialUsageResource);
  resources.register(usage, MessageUsageResource.record);

  // Input append belongs to the scene; the actual accepted range is the next scope's basis.
  resources.capture(scene, (_input, options) => ({ transcript: entities.transcript, progress: capture.inputProgress(options) })).register(TranscriptResource.append, (messages) => messages);

  // One capture fixes the related values together; children inherit that exact supply.
  const task = resources.capture(conversation, (accepted, options) => captureTaskResources(entities, capture, accepted, options));
  task
    .register(TranscriptResource.fixedRange, (supply) => supply.history)
    .register(ModelSettingsResource.snapshot, (supply) => supply.settings)
    .register(ModelSettingsResource.timeout, (supply) => supply.settings.timeoutMs)
    .register(MemoryResource.snapshot, (supply) => supply.memories)
    .register(TranscriptResource.append, (supply) => supply.messages)
    .register(ConversationTaskResource, (supply) => supply.tasks);
  if (scene.filesEnabled) task.register(FileResources.inspect, fileSupply).register(FileResources.readText, fileSupply).register(FileResources.createText, fileSupply);
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
}

/** The host recovery basis and the normal call use the same resource scope. */
function captureTaskResources(entities: ConversationEntities, capture: ConversationCallCapture, accepted: AcceptedConversationInput, options: ConversationRunOptions) {
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
}

function fileSupply(supply: { readonly files?: FileResourceSource }): FileResourceSource {
  if (!supply.files) throw new Error('A configured file workspace is required');
  return supply.files;
}
