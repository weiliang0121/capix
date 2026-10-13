import type { ClientState, ClientSubmissionState } from '@capix/client-runtime';
import type { ConversationMessage } from '../state/conversation.js';
import { responseLocator } from './responses.js';

const maximumDeferredMessages = 32;

/** Coordinate formal-answer presentation with explicit feedback identity, never with text matching. */
export function createRevealProjection() {
  let initialized = false;
  let transcriptId: string | undefined;
  let seenEnd = 0;
  let previousIds = new Set<string>();
  const eligible = new Set<string>();
  const revealed = new Map<number, string>();
  const deferred = new Map<number, string>();
  let overflowedSubmission: string | undefined;
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
    for (const [id, submission] of tracked) {
      const preview = submission.preview;
      const answer = responseLocator(submission);
      // A view opened during generation already displays a live preview. Its later
      // formal body continues that display even though this is not a new local submission.
      if (preview?.status === 'live' && preview.snapshot && preview.snapshot.state !== 'discarded' && (!answer || answer.transcriptId !== state.transcriptId || rows[answer.index]?.message.role !== 'assistant')) eligible.add(id);
    }
    let changed = false;
    if (transcriptId !== state.transcriptId) {
      // A new collection is a history view. The first identified collection may also
      // contain a locally submitted answer completed before the next browser frame.
      seenEnd = transcriptId === undefined ? seenEnd : rows.length;
      if (transcriptId !== undefined) eligible.clear();
      transcriptId = state.transcriptId;
      changed = revealed.size > 0 || deferred.size > 0;
      revealed.clear();
      deferred.clear();
      overflowedSubmission = undefined;
    }
    const transcript = transcriptId ? state.transcripts.get(transcriptId) : undefined;
    if (transcript && transcript.sync.status !== 'live') eligible.clear();
    for (const [index, id] of revealed) {
      if (!ids.has(id) || index >= rows.length) {
        revealed.delete(index);
        changed = true;
      }
    }
    const current = state.submission;
    if (overflowedSubmission !== current?.id) overflowedSubmission = undefined;
    const awaitingLocator = (submission: ClientSubmissionState | undefined) => !!submission && !submission.remote?.result && submission.preview?.status === 'live' && !!submission.preview.snapshot && submission.preview.snapshot.state !== 'discarded' && !responseLocator(submission) && submission.remote?.input?.transcriptId === transcriptId;
    if (rows !== previousRows && initialized && current && current.id !== overflowedSubmission && awaitingLocator(current)) {
      for (const row of rows) {
        if (row.index === undefined || row.index < seenEnd || row.index < current.remote!.input!.end || row.message.role !== 'assistant') continue;
        deferred.set(row.index, current.id);
        changed = true;
      }
      // This is a bounded display buffer, not ownership of new formal content.
      // Unexpected volume degrades to ordinary readable messages for this submission.
      if (deferred.size > maximumDeferredMessages) {
        deferred.clear();
        overflowedSubmission = current.id;
        changed = true;
      }
    }
    const submissions = new Map([...tracked.values()].map((submission) => [submission.id, submission]));
    for (const [index, owner] of deferred) {
      const submission = submissions.get(owner);
      const answer = submission ? responseLocator(submission) : undefined;
      if (submission && answer && answer.transcriptId === transcriptId && answer.index === index) {
        revealed.set(index, submission.queueId);
        deferred.delete(index);
        changed = true;
      } else if (!awaitingLocator(submission) || index >= rows.length) {
        // A terminal or released submission cannot withhold unrelated formal content.
        deferred.delete(index);
        changed = true;
      }
    }
    if (transcriptId) {
      for (const id of eligible) {
        const submission = tracked.get(id);
        const answer = submission ? responseLocator(submission) : undefined;
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
      output = rows.filter((row) => row.index === undefined || !deferred.has(row.index)).map((row) => (row.index !== undefined && revealed.has(row.index) ? { ...row, reveal: true } : row));
      previousRows = rows;
    }
    return output;
  };
}
