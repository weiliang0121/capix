import { MemoryResource } from '@capix/memory';
import type { ModelProvider } from '@capix/model-provider';
import { Resource } from '@capix/resources';
import { Resources } from '@capix/server-runtime';
import { TranscriptResource } from '@capix/transcript';
import type { ViewPersistence } from '@capix/view';
import { CompletionResource } from '../completion.js';
import { ConversationViewResource, type ConversationMaterialSources, type ConversationViewSource } from '../materials/view.js';
import { ConversationMemoryResource } from '../memory/context.js';
import { CompletionInteractionResource } from '../model/completion.js';
import { CompletionInteraction } from '../model/completion-contract.js';
import { ConversationRecoveryResource } from '../recovery/basis.js';

/** Register actual entities and narrow Offers. The registry does not invent entity associations. */
export function createConversationResources(content: ConversationViewSource, model: ModelProvider, viewPersistence?: ViewPersistence<ConversationMaterialSources>, configuration = 'embedded-v1') {
  const resources = new Resources();
  registerConversationResources(resources, content, model, viewPersistence, configuration);
  return resources;
}

/** Preserve the host's entry options type when composing resource registrations. */
export function registerConversationResources<Options extends object>(resources: Resources<Options>, content: ConversationViewSource, model: ModelProvider, viewPersistence?: ViewPersistence<ConversationMaterialSources>, configuration = 'embedded-v1'): void {
  const materials = new Resource({ ...content, persistence: viewPersistence });
  const memory = new Resource(content.memories);
  resources
    .register(new Resource({ ...content, configuration }), ConversationRecoveryResource)
    .register(new Resource(content.transcript), TranscriptResource.append)
    .register(materials, ConversationViewResource.read)
    .register(materials, ConversationViewResource.manage)
    .register(memory, ConversationMemoryResource)
    .register(memory, MemoryResource.apply)
    .register(new Resource(model), CompletionResource)
    .registerInteraction(CompletionInteractionResource.start, CompletionInteraction)
    .registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
}
