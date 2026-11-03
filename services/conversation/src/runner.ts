import { Resource } from '@capix/resources';
import type { ModelProvider } from '@capix/model-provider';
import { Resources, Runner, type ObservationInstallation } from '@capix/server-runtime';
import { TranscriptResource, type Transcript } from '@capix/transcript';
import { HistoryResource } from './history.js';
import { CompletionResource } from './completion.js';
import { createConversationScene } from './scene.js';

/** Assemble public kernel objects. The host keeps ownership of its transcript, model and observers. */
export function createConversationRunner(transcript: Transcript, model: ModelProvider, options: { readonly observations?: readonly ObservationInstallation[] } = {}) {
  const messages = new Resource(transcript);
  const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).register(new Resource(model), CompletionResource);
  return new Runner(createConversationScene(), resources, undefined, { observations: options.observations }).build();
}
