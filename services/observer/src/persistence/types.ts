import type { RecordBookState } from '@weiliang0121/capix-records';
import type { RecordingArchive } from '@weiliang0121/capix-protocol';
import type { InteractionPersistence, InteractionState } from '@weiliang0121/capix-interaction';

export type { RecordingArchive } from '@weiliang0121/capix-protocol';

/** Interactions are independent entities, loaded on demand rather than with the conversation baseline. */
export interface ObserverInteractionPersistence extends InteractionPersistence {
  read(id: string): InteractionState | undefined;
}

/** Stored content is independent of optional recording and of the current service process. */
export type ObserverStoredContent = import('@capix/observer-content').ConversationContentState;

/** Historical observation is recovered independently from required content. */
export interface ObserverStoredRecording {
  readonly book: RecordBookState;
  readonly archives: readonly RecordingArchive[];
}
