import type { TranscriptState, TranscriptPersistence } from '@capix/transcript';
import type { MemoriesState, MemoriesPersistence } from '@capix/memory';
import type { ActiveViewState, ActiveViewPersistence } from './view/state.js';

/** Stored content is independent of optional recording and of the current service process. */
export interface ConversationContentState {
  readonly version: 1;
  readonly transcript: TranscriptState;
  readonly memories: MemoriesState;
  readonly active?: ActiveViewState;
}

/** Content uses entity commits and failure reporting; choosing and loading storage belongs to its host. */
export interface ConversationContentPersistence {
  readonly transcript: TranscriptPersistence;
  readonly memories: MemoriesPersistence;
  readonly activeView: ActiveViewPersistence;
  invalidateContent(cause: unknown): void;
}
