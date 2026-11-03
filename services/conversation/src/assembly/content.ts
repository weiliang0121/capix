import { Memories, MemoryViewSource, type MemoriesPersistence, type MemoriesState } from '@capix/memory';
import { Transcript, TranscriptViewSource, type TranscriptPersistence, type TranscriptState } from '@capix/transcript';
import { View, type ViewPersistence, type ViewState } from '@capix/view';
import type { ConversationMaterialSources, ConversationViewSource } from '../materials/view.js';

/** Persistent content only. No structure, running call, model request or subscription. */
export interface ConversationState {
  readonly transcript: TranscriptState;
  readonly memories: MemoriesState;
  readonly view: ViewState<ConversationMaterialSources>;
}

export interface ConversationPersistence {
  readonly transcript: TranscriptPersistence;
  readonly memories: MemoriesPersistence;
  readonly view: ViewPersistence<ConversationMaterialSources>;
}

/** The host chooses the store and owns its lifetime. Each entity keeps its own commit boundary. */
export interface ConversationContentStore extends ConversationPersistence {
  load(): ConversationState | undefined;
  initialize(state: ConversationState): void;
  assertAvailable(): void;
}

/** Rehydrate real entities and check their fixed association before allowing another submission. */
export function restoreConversationContent(state: ConversationState, persistence?: ConversationPersistence): ConversationViewSource {
  const transcript = Transcript.restore(state.transcript, { persistence: persistence?.transcript });
  const memories = Memories.restore(state.memories, transcript, { persistence: persistence?.memories });
  const view = new View<ConversationMaterialSources>(state.view);
  const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) };
  const slots = Object.keys(view.exportState().sources);
  if (slots.length !== 2 || !slots.includes('messages') || !slots.includes('memories')) throw new Error('Conversation content requires exactly the messages and memories View sources');
  // Validates source identities, scope, keys and source versions; does not re-include anything.
  view.indexSync(sources);
  return Object.freeze({ transcript, memories, view });
}

export function loadConversationContent(store: ConversationContentStore): ConversationViewSource {
  store.assertAvailable();
  const saved = store.load();
  if (saved) return restoreConversationContent(saved, store);
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const state: ConversationState = {
    transcript: transcript.exportState(),
    memories: memories.exportState(),
    view: { revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] },
  };
  // Initial identities are saved together. Later message, memory and membership commits are separate.
  store.initialize(state);
  return restoreConversationContent(state, store);
}
