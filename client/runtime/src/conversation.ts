import type { Message } from '@capix/protocol';
import type { ClientSubmissionState } from './submission.js';
import type { TranscriptState } from './transcript.js';

/** Locator knowledge and local content availability; independent of connection health. */
export type ContentAvailability = 'unconfirmed' | 'unloaded' | 'pending' | 'available';

interface ConversationSources {
  readonly transcriptId?: string;
  readonly transcripts: ReadonlyMap<string, TranscriptState>;
  readonly submission?: ClientSubmissionState;
}

const emptyMessages: readonly Readonly<Message>[] = Object.freeze([]);

/** Combine accepted facts without inferring a business result from delivery or content. */
export function coordinateConversation(sources: ConversationSources) {
  const submission = sources.submission;
  const remote = submission?.remote;
  return {
    messages: (sources.transcriptId ? sources.transcripts.get(sources.transcriptId)?.snapshot?.messages : undefined) ?? emptyMessages,
    busy: Boolean(submission && !remote?.result),
    pending: submission && !remote?.input && !remote?.result ? (submission.pending ?? '') : '',
    contextId: remote?.executions.at(-1)?.contextId ?? '',
    answered: Boolean(remote?.answer),
    inputAvailability: availability(sources.transcripts, remote?.input),
    answerAvailability: availability(sources.transcripts, remote?.answer ? { transcriptId: remote.answer.transcriptId, end: remote.answer.index + 1 } : undefined),
  };
}

function availability(transcripts: ReadonlyMap<string, TranscriptState>, locator?: { transcriptId: string; end: number }): ContentAvailability {
  if (!locator) return 'unconfirmed';
  const snapshot = transcripts.get(locator.transcriptId)?.snapshot;
  if (!snapshot) return 'unloaded';
  return snapshot.end >= locator.end ? 'available' : 'pending';
}
