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

/** Register actual entities and narrow Offers. The registry does not invent entity associations. */
export function createConversationResources(content: ConversationViewSource, model: ModelProvider, viewPersistence?: ViewPersistence<ConversationMaterialSources>) {
  const materials = new Resource({ ...content, persistence: viewPersistence });
  const memory = new Resource(content.memories);
  return new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(materials, ConversationViewResource.read).register(materials, ConversationViewResource.manage).register(memory, ConversationMemoryResource).register(memory, MemoryResource.apply).register(new Resource(model), CompletionResource).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
}
