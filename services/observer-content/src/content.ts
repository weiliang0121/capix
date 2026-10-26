import { ChangeBuffer, type EventConsumer } from '@capix/changes';
import { RuntimeError } from '@capix/contracts';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { ActiveView } from '@capix/view';
import type { Message, ObserverChange, TranscriptEvent, MemoryEvent } from '@capix/protocol';
import { ChangeConsumer } from './synchronization/consumer.js';
import { TranscriptFeed } from './synchronization/transcript.js';
import type { ContentObservation } from './observation.js';
import type { ConversationContentState, ConversationContentPersistence } from './persistence.js';

export interface ConversationContentOptions {
  readonly saved?: ConversationContentState;
  readonly messages?: readonly Message[];
  readonly persistence?: ConversationContentPersistence;
}

/** Content and its synchronization outlive any borrowed runtime/recording installation. */
export class ConversationContent {
  readonly transcript: Transcript;
  readonly memories: Memories;
  readonly active: ActiveView;
  readonly changes = new ChangeBuffer<ObserverChange>();
  readonly consumer = new ChangeConsumer(this.changes);
  readonly transcripts: TranscriptFeed;
  #observation?: ContentObservation;
  #closed = false;

  constructor(options: ConversationContentOptions = {}) {
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
      this.active = new ActiveView(this.transcript, this.memories, { saved: saved?.active, persistence: persistence?.activeView });
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
