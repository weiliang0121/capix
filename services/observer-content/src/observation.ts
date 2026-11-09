import type { EventConsumer } from '@weiliang0121/capix-changes';
import type { TranscriptEvent, MemoryEvent } from '@weiliang0121/capix-protocol';

/** One borrowed Observer installation observes content without owning its lifetime. */
export interface ContentObservation {
  readonly transcript: EventConsumer<TranscriptEvent>;
  readonly memory: EventConsumer<MemoryEvent>;
}
