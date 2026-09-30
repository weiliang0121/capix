import type { TranscriptEvent } from '@capix-observer/protocol';
export type { TranscriptEvent } from '@capix-observer/protocol';

/** Messages have already been accepted and frozen by Transcript. */
export function createTranscriptEvent(transcriptId: string, revision: number, change: TranscriptEvent['change']): TranscriptEvent {
  const body = change.kind === 'messages-appended' ? Object.freeze({ ...change, messages: Object.freeze([...change.messages]) }) : Object.freeze({ ...change });
  return Object.freeze({ type: 'transcript', transcriptId, revision, occurredAt: new Date().toISOString(), change: body });
}
