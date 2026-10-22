import { type Driver, bindChildResources } from '@capix/server-runtime';
import type { ModelInteractions } from './model/interactions.js';
import type { ConversationStructure } from './scene.js';
import { conversationProviders, conversationFileProviders } from './resources.js';
import { FileResources } from '../files/index.js';
import type { DocumentProcessingInput } from './group/document/process.js';
import type { CreateTextInput } from './node/files/create.js';
import type { ConversationBindingOptions, ConversationEntities } from './binding/contract.js';
import { ConversationCallSource } from './binding/source.js';

export type { ConversationRunOptions, ConversationEntities, ConversationBindingOptions } from './binding/contract.js';

/** Build the existing scene using fixed resource wiring; per-call capture remains deferred. */
export function buildConversation(driver: Driver, structure: ConversationStructure, entities: ConversationEntities, model: ModelInteractions, capabilities: ConversationBindingOptions = {}) {
  const { scene, conversation, document, save } = structure;
  if (scene.filesEnabled && !entities.files) throw new Error('File-enabled conversation requires a workspace file entity');
  const source = new ConversationCallSource(scene, entities, model, capabilities, driver.checkpointStore);
  return driver.build(scene, {
    childResources: [...(document ? [bindChildResources(document, [FileResources.readText.refine((input: DocumentProcessingInput) => input.sourcePath)])] : []), ...(save ? [bindChildResources(save, [FileResources.createText.refine((input: CreateTextInput) => input.path)])] : [])],
    providers: [...conversationProviders, ...(scene.filesEnabled ? conversationFileProviders : [])],
    source,
    bindings: [
      {
        definition: conversation,
        capture: (input, options) => source.captureTask(input, options),
        started: (options) => source.startedTask(options),
        output: (options) => source.taskOutput(options),
      },
    ],
  });
}
export type BuiltConversationScene = ReturnType<typeof buildConversation>;
