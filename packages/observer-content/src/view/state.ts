import type { MemoryState } from '@weiliang0121/capix-memory';
import type { Message } from '@weiliang0121/capix-protocol';

/** Current membership belongs to the conversation's content; it has no independent identity. */
export interface ActiveViewState {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly revision: number;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveViewBasis {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly indexRevision: number;
  readonly transcriptRevision: number;
  readonly memorySequence: number;
}

/** Actual immutable values, not handles which could later read updated memory contents. */
export interface ActiveViewSnapshot {
  readonly basis: ActiveViewBasis;
  readonly messages: readonly { readonly index: number; readonly message: Readonly<Message> }[];
  readonly memories: readonly MemoryState[];
}

export interface ActiveViewSelection {
  readonly basis: ActiveViewBasis;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveViewPersistence {
  commit(change: { readonly basis: ActiveViewBasis; readonly state: ActiveViewState }): undefined;
}

export function freezeActiveView(state: ActiveViewState): ActiveViewState {
  if (!state || typeof state.transcriptId !== 'string' || !state.transcriptId || typeof state.memoriesId !== 'string' || !state.memoriesId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.messageIndexes) || !Array.isArray(state.memoryIds)) throw new TypeError('Invalid active content index');
  if (new Set(state.messageIndexes).size !== state.messageIndexes.length || state.messageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(state.memoryIds).size !== state.memoryIds.length || state.memoryIds.some((id) => typeof id !== 'string' || !id)) throw new TypeError('Invalid active content members');
  return Object.freeze({ transcriptId: state.transcriptId, memoriesId: state.memoriesId, revision: state.revision, messageIndexes: Object.freeze([...state.messageIndexes]), memoryIds: Object.freeze([...state.memoryIds]) });
}
