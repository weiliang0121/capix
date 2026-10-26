import type { EventConsumer } from '@capix/changes';
import type { TranscriptEvent, MemoryEvent } from '@capix/protocol';

/** One borrowed Observer installation observes content without owning its lifetime. */
export interface ContentObservation {
  readonly transcript: EventConsumer<TranscriptEvent>;
  readonly memory: EventConsumer<MemoryEvent>;
}
