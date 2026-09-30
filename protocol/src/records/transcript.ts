import type { Message } from '../message.js';
import type { BaseRecord } from '../records.js';

export type TranscriptChange = { readonly action: 'append'; readonly start: number; readonly messages: readonly Readonly<Message>[] } | { readonly action: 'segment'; readonly previousStart: number; readonly start: number; readonly end: number };

export interface TranscriptRecord extends BaseRecord<TranscriptChange> {
  readonly transcriptId: string;
  readonly occurredAt: string;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
}
