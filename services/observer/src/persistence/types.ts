import type { RecordBookState } from '@capix/server-runtime/recording';
import type { TranscriptState, MemoriesState } from '@capix/server-runtime/content';
import type { RecordingArchive } from '@capix/protocol';

export type { RecordingArchive } from '@capix/protocol';

/** Stored content is independent of optional recording and of the current service process. */
export interface ObserverStoredState {
  readonly version: 1;
  readonly transcript: TranscriptState;
  readonly memories: MemoriesState;
  readonly recording: {
    readonly book: RecordBookState;
    readonly archives: readonly RecordingArchive[];
  };
}
