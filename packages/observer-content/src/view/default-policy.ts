import { freezeActiveView, type ActiveViewState } from './state.js';

/** Observer's initial preset includes the current segment and all existing memories. */
export function initialActiveView(transcriptId: string, memoriesId: string, start: number, end: number, memoryIds: readonly string[]): ActiveViewState {
  return freezeActiveView({ transcriptId, memoriesId, revision: 0, messageIndexes: Array.from({ length: end - start }, (_, offset) => start + offset), memoryIds });
}

/** Include newly appended/created members, preserving order and all existing exclusions. Hosts own persistence. */
export function appendActiveView(state: ActiveViewState, messageIndexes: readonly number[], memoryIds: readonly string[]): ActiveViewState {
  if (!messageIndexes.length && !memoryIds.length) return state;
  if (!Number.isSafeInteger(state.revision + 1)) throw new RangeError('Active content revision is exhausted');
  return freezeActiveView({ ...state, revision: state.revision + 1, messageIndexes: [...state.messageIndexes, ...messageIndexes], memoryIds: [...state.memoryIds, ...memoryIds] });
}
