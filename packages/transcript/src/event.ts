import { FactType } from '@weiliang0121/capix-changes';
import type { InvocationOrigin } from '@weiliang0121/capix-contracts';
import type { Message } from './types.js';

/** A fixed domain change; publication does not grant replay or recovery authority. */
export type TranscriptEvent = Readonly<{ type: 'transcript'; transcriptId: string; revision: number; occurredAt: string; origin?: InvocationOrigin; change: Readonly<{ kind: 'messages-appended'; start: number; messages: readonly Readonly<Message>[] }> | Readonly<{ kind: 'segment-started'; previousStart: number; start: number; end: number }> }>;

/** One producer-owned type identity; its name is descriptive, not a routing key. */
export const TranscriptFacts = new FactType<TranscriptEvent>('transcript');

/** Messages have already been accepted and frozen by Transcript. */
export function createTranscriptEvent(transcriptId: string, revision: number, change: TranscriptEvent['change'], origin?: { readonly contextId: string }): TranscriptEvent {
  const body = change.kind === 'messages-appended' ? Object.freeze({ ...change, messages: Object.freeze([...change.messages]) }) : Object.freeze({ ...change });
  return Object.freeze({ type: 'transcript', transcriptId, revision, occurredAt: new Date().toISOString(), ...(origin ? { origin: Object.freeze({ ...origin }) } : {}), change: body });
}
