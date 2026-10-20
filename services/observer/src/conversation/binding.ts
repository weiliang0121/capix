import { type Driver, bindChildResources } from '@capix/server-runtime';
import type { ModelInteractions } from './model/interactions.js';
import type { ConversationSceneDefinition } from './scene.js';
import { conversationProviders, conversationFileProviders } from './resources.js';
import { FileResources } from '../files/index.js';
import type { DocumentProcessingInput } from './group/document/process.js';
import type { CreateTextInput } from './node/files/create.js';
import type { ConversationBindingOptions, ConversationEntities } from './binding/contract.js';
import { ConversationCallSource } from './binding/source.js';

export type { ConversationRunOptions, ConversationEntities, ConversationBindingOptions } from './binding/contract.js';

/** Bind fixed declarations and independent supplies. Per-call capture belongs to the source. */
export function bindConversation(driver: Driver, definition: ConversationSceneDefinition, entities: ConversationEntities, model: ModelInteractions, capabilities: ConversationBindingOptions = {}) {
  if (definition.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const operations = definition.taskDefinition.operationDefinitions;
  const source = new ConversationCallSource(definition, entities, model, capabilities, driver.checkpointStore);
  return driver.bind(definition, {
    childResources: [...(operations.document ? [bindChildResources(operations.document, [FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath)])] : []), ...(operations.save ? [bindChildResources(operations.save, [FileResources.createText.refine((input: CreateTextInput) => input.path)])] : [])],
    providers: [...conversationProviders, ...(definition.filesEnabled ? conversationFileProviders : [])],
    source,
    bindings: [
      {
        definition: definition.taskDefinition,
        capture: (input, options) => source.captureTask(input, options),
        started: (options) => source.startedTask(options),
        output: (options) => source.taskOutput(options),
      },
    ],
  });
}
export type ConversationScene = ReturnType<typeof bindConversation>;
