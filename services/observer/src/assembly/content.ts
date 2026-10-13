import { ChangeBuffer, type EventConsumer } from '@capix/server-runtime';
import { Transcript, Memories } from '@capix/server-runtime/content';
import type { Message, ObserverChange, TranscriptEvent, MemoryEvent } from '@capix/protocol';
import { ChangeConsumer } from './changes.js';
import { TranscriptFeed } from '../conversation/transcript/feed.js';
import type { ObserverStoredContent } from '../persistence/types.js';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Content and its synchronization live independently of runtime or recording installation. */
export function restoreConversationContent(saved: ObserverStoredContent | undefined, messages: readonly Message[], persistence?: SqliteObserverStore) {
  let observation: { transcript: EventConsumer<TranscriptEvent>; memory: EventConsumer<MemoryEvent> } | undefined;
  const transcriptObservation: EventConsumer<TranscriptEvent> = { publish: (event) => observation?.transcript.publish(event) };
  const memoryObservation: EventConsumer<MemoryEvent> = { publish: (event) => observation?.memory.publish(event) };
  const changes = new ChangeBuffer<ObserverChange>();
  const consumer = new ChangeConsumer(changes);
  let transcript: Transcript;
  let memories: Memories;
  try {
    transcript = saved ? Transcript.restore(saved.transcript, { changes, observation: transcriptObservation, persistence: persistence?.transcript }) : new Transcript(messages, { changes, observation: transcriptObservation });
    memories = saved ? Memories.restore(saved.memories, transcript, { changes, observation: memoryObservation, persistence: persistence?.memories }) : new Memories(transcript, { changes, observation: memoryObservation });
  } catch (error) {
    consumer.close();
    if (saved && persistence) persistence.invalidateContent(error);
    throw error;
  }
  const transcripts = new TranscriptFeed(transcript);
  consumer.subscribe((change) => {
    if (change.type === 'transcript') transcripts.publish(change);
  });
  return {
    transcript,
    memories,
    changes,
    consumer,
    transcripts,
    observe(value: NonNullable<typeof observation>): void {
      if (observation) throw new Error('Content observation is already installed');
      observation = value;
    },
  };
}
export type ConversationContent = ReturnType<typeof restoreConversationContent>;
