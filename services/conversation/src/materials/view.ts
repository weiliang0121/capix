import { MemoryViewSource, type Memories } from '@capix/memory';
import { ResourceOffer } from '@capix/resources';
import { TranscriptViewSource, type Transcript } from '@capix/transcript';
import { openView, openViewManager, type View, type ViewPersistence } from '@capix/view';

/** These two source slots are a service choice, not a universal context contract. */
export type ConversationMaterialSources = {
  readonly messages: TranscriptViewSource;
  readonly memories: MemoryViewSource;
};

export interface ConversationViewSource {
  readonly view: View<ConversationMaterialSources>;
  readonly transcript: Transcript;
  readonly memories: Memories;
}

export interface ConversationViewManagementSource extends ConversationViewSource {
  readonly persistence?: ViewPersistence<ConversationMaterialSources>;
}

/** Reading selected material and changing membership are separately registered permissions. */
export const ConversationViewResource = Object.freeze({
  read: new ResourceOffer({
    name: 'conversation.view.read',
    expose: (source: ConversationViewSource, activity) => openView(source.view, viewSources(source), activity),
  }),
  manage: new ResourceOffer({
    name: 'conversation.view.manage',
    expose: (source: ConversationViewManagementSource, activity) => {
      const sources = viewSources(source);
      const manager = openViewManager(source.view, sources, activity, source.persistence);
      return Object.freeze({ transcriptId: source.transcript.id, memoriesId: source.memories.id, ...manager });
    },
  }),
});

/** Validate the fixed wiring even when a membership operation would make no change. */
function viewSources({ view, transcript, memories }: ConversationViewSource): ConversationMaterialSources {
  if (memories.transcript !== transcript) throw new Error('Conversation memories belong to another transcript');
  const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) };
  const registered = view.exportState().sources;
  for (const slot of ['messages', 'memories'] as const) {
    if (registered[slot]?.id !== sources[slot].id || registered[slot]?.scope !== sources[slot].scope) throw new Error('Conversation view source identity or scope does not match its entities');
  }
  return sources;
}
