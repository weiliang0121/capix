import { MemoryViewSource, type Memories } from '@capix/memory';
import { ResourceOffer } from '@capix/resources';
import { TranscriptViewSource, type Transcript } from '@capix/transcript';
import { openView, type View } from '@capix/view';

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

/** Reading the selected material does not grant either membership changes or entity writes. */
export const ConversationViewResource = new ResourceOffer({
  name: 'conversation.view',
  expose: ({ view, transcript, memories }: ConversationViewSource, activity) => {
    if (memories.transcript !== transcript) throw new Error('Conversation memories belong to another transcript');
    return openView(view, { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) }, activity);
  },
});
