import type { RecordBookState } from '@capix/server-runtime/recording';
import type { TranscriptState, MemoriesState } from '@capix/server-runtime/content';
import type { RecordingArchive } from '@capix/protocol';
import type { InteractionPersistence, InteractionState } from '@capix/server-runtime';
import type { ActiveContentState } from '../conversation/content/active.js';

export type { RecordingArchive } from '@capix/protocol';

/** Interactions are independent entities, loaded on demand rather than with the conversation baseline. */
export interface ObserverInteractionPersistence extends InteractionPersistence {
  read(id: string): InteractionState | undefined;
}

/** Stored content is independent of optional recording and of the current service process. */
export interface ObserverStoredContent {
  readonly version: 1;
  readonly transcript: TranscriptState;
  readonly memories: MemoriesState;
  readonly active?: ActiveContentState;
}

/** Historical observation is recovered independently from required content. */
export interface ObserverStoredRecording {
  readonly book: RecordBookState;
  readonly archives: readonly RecordingArchive[];
}
