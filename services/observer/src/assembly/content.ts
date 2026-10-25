import { ChangeBuffer, RuntimeError, type EventConsumer } from '@capix/server-runtime';
import { Transcript, Memories } from '@capix/server-runtime/content';
import type { Message, ObserverChange, TranscriptEvent, MemoryEvent } from '@capix/protocol';
import { ChangeConsumer } from './changes.js';
import { TranscriptFeed } from '../conversation/transcript/feed.js';
import type { ObserverStoredContent } from '../persistence/types.js';
import type { SqliteObserverStore } from '../persistence/store.js';
import { ActiveContent } from '../conversation/content/active.js';

export interface ContentObservation {
  readonly transcript: EventConsumer<TranscriptEvent>;
  readonly memory: EventConsumer<MemoryEvent>;
}

/** Resolve content ownership and durable identity before installing a running environment. */
export function loadConversationContent(messages: readonly Message[], options: { readonly content?: ConversationContent; readonly persistence?: SqliteObserverStore; readonly conversationId?: string }): ConversationContent {
  const { content, persistence, conversationId } = options;
  if (content) {
    if (content.closed) throw new RuntimeError('SERVICE_CLOSED', '对话内容同步已关闭。');
    if (persistence) {
      const identity = conversationId ? persistence.contentIdentity(conversationId) : undefined;
      if (!identity || identity.transcriptId !== content.transcript.id || identity.memoriesId !== content.memories.id || content.memories.transcript !== content.transcript) throw new Error('Content belongs to another conversation');
    }
    return content;
  }
  let saved = persistence?.loadContent(conversationId);
  if (saved && messages.length) throw new Error('Cannot append startup messages to restored content');
  if (persistence && !saved) {
    const transcript = new Transcript(messages);
    const memories = new Memories(transcript);
    saved = { version: 1, transcript: transcript.exportState(), memories: memories.exportState() };
    persistence.initialize(saved);
  }
  // Fresh memory-only messages are appended after recording is installed.
  return new ConversationContent({ saved, messages: persistence ? messages : [], persistence });
}

/** Content and its synchronization outlive any borrowed runtime/recording installation. */
export class ConversationContent {
  readonly transcript: Transcript;
  readonly memories: Memories;
  readonly active: ActiveContent;
  readonly changes = new ChangeBuffer<ObserverChange>();
  readonly consumer = new ChangeConsumer(this.changes);
  readonly transcripts: TranscriptFeed;
  #observation?: ContentObservation;
  #closed = false;

  constructor(options: { readonly saved?: ObserverStoredContent; readonly messages?: readonly Message[]; readonly persistence?: SqliteObserverStore } = {}) {
    const { saved, persistence } = options;
    const transcriptObservation: EventConsumer<TranscriptEvent> = { publish: (event) => this.#observation?.transcript.publish(event) };
    const memoryObservation: EventConsumer<MemoryEvent> = { publish: (event) => this.#observation?.memory.publish(event) };
    const changes = {
      capture: (event: TranscriptEvent | MemoryEvent) => {
        this.active?.synchronize();
        this.changes.capture(event);
      },
    };
    try {
      this.transcript = saved ? Transcript.restore(saved.transcript, { changes, observation: transcriptObservation, persistence: persistence?.transcript }) : new Transcript(options.messages ?? [], { changes, observation: transcriptObservation });
      this.memories = saved ? Memories.restore(saved.memories, this.transcript, { changes, observation: memoryObservation, persistence: persistence?.memories }) : new Memories(this.transcript, { changes, observation: memoryObservation });
      this.active = new ActiveContent(this.transcript, this.memories, { saved: saved?.active, persistence: persistence?.activeContent });
    } catch (error) {
      let failure = error;
      try {
        this.consumer.close();
      } catch (cleanup) {
        failure = new AggregateError([error, cleanup], 'Conversation content restoration and cleanup failed');
      }
      if (saved && persistence) persistence.invalidateContent(failure);
      throw failure;
    }
    this.transcripts = new TranscriptFeed(this.transcript);
    this.consumer.subscribe((change) => {
      if (change.type === 'transcript') this.transcripts.publish(change);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The installation receives a release handle; releasing it never stops content delivery. */
  observe(observation: ContentObservation): () => void {
    if (this.#closed) throw new RuntimeError('SERVICE_CLOSED', '对话内容同步已关闭。');
    if (this.#observation) throw new Error('Content observation is already installed');
    this.#observation = observation;
    return () => {
      if (this.#observation === observation) this.#observation = undefined;
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#observation = undefined;
    const failures: unknown[] = [];
    try {
      this.transcripts.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.consumer.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Conversation content cleanup failed');
  }
}
