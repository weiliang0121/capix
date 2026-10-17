import { assembleRuntime, bindChildResources } from '@capix/server-runtime';
import type { ModelInteractions } from './model/interactions.js';
import type { ConversationRuntimeDefinition } from './definition.js';
import { conversationProviders, conversationFileProviders } from './resources.js';
import { FileResources } from '../files/index.js';
import type { DocumentProcessingInput } from './operations/document/process.js';
import type { CreateTextInput } from './attempt/files/create.js';
import type { ConversationBindingOptions, ConversationEntities } from './binding/contract.js';
import { ConversationCallSource } from './binding/source.js';

export type { ConversationRunOptions, ConversationEntities, ConversationBindingOptions } from './binding/contract.js';

/** Bind fixed declarations and independent supplies. Per-call capture belongs to the source. */
export function bindConversation(definition: ConversationRuntimeDefinition, entities: ConversationEntities, model: ModelInteractions, capabilities: ConversationBindingOptions = {}) {
  if (definition.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const operations = definition.executionDefinition.operationDefinitions;
  return assembleRuntime(definition, {
    observations: capabilities.observations,
    changes: capabilities.changes,
    checkpoints: capabilities.checkpoints,
    childResources: [...(operations.document ? [bindChildResources(operations.document, [FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath)])] : []), ...(operations.save ? [bindChildResources(operations.save, [FileResources.createText.refine((input: CreateTextInput) => input.path)])] : [])],
    providers: [...conversationProviders, ...(definition.filesEnabled ? conversationFileProviders : [])],
    source: new ConversationCallSource(definition, entities, model, capabilities),
  });
}
export type BoundConversationRuntime = ReturnType<typeof bindConversation>;
