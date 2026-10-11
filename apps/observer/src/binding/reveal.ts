import type { ClientState, ClientSubmissionState } from '@capix/client-runtime';
import type { ConversationMessage } from '../state/conversation.js';

/** Decide once when a formal answer first enters this presentation, never by comparing its text. */
export function createRevealProjection() {
  let initialized = false;
  let transcriptId: string | undefined;
  let seenEnd = 0;
  let previousIds = new Set<string>();
  const eligible = new Set<string>();
  const revealed = new Map<number, string>();
  let previousRows: readonly ConversationMessage[] | undefined;
  let output: readonly ConversationMessage[] = [];

  return (rows: readonly ConversationMessage[], state: ClientState): readonly ConversationMessage[] => {
    const tracked = new Map<string, ClientSubmissionState>();
    for (const submission of state.submissions.values()) tracked.set(submission.queueId, submission);
    if (state.submission) tracked.set(state.submission.queueId, state.submission);
    const ids = new Set(tracked.keys());
    for (const id of eligible) {
      if (!ids.has(id)) eligible.delete(id);
    }
    if (initialized) {
      for (const id of ids) {
        if (!previousIds.has(id)) eligible.add(id);
      }
    }
    let changed = false;
    if (transcriptId !== state.transcriptId) {
      // A new collection is a history view. The first identified collection may also
      // contain a locally submitted answer completed before the next browser frame.
      seenEnd = transcriptId === undefined ? seenEnd : rows.length;
      if (transcriptId !== undefined) eligible.clear();
      transcriptId = state.transcriptId;
      changed = revealed.size > 0;
      revealed.clear();
    }
    const transcript = transcriptId ? state.transcripts.get(transcriptId) : undefined;
    if (transcript && transcript.sync.status !== 'live') eligible.clear();
    for (const [index, id] of revealed) {
      if (!ids.has(id) || index >= rows.length) {
        revealed.delete(index);
        changed = true;
      }
    }
    if (transcriptId) {
      for (const id of eligible) {
        const answer = tracked.get(id)?.remote?.answer;
        if (!answer || answer.transcriptId !== transcriptId || answer.index < seenEnd || rows[answer.index]?.message.role !== 'assistant') continue;
        revealed.set(answer.index, id);
        changed = true;
      }
    }
    // Already projected static content stays static even if its answer locator arrives later.
    seenEnd = Math.max(seenEnd, rows.length);
    previousIds = ids;
    initialized = true;
    if (rows !== previousRows || changed) {
      output = rows.map((row) => (row.index !== undefined && revealed.has(row.index) ? { ...row, reveal: true } : row));
      previousRows = rows;
    }
    return output;
  };
}
