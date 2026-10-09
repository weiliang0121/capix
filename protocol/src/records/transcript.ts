import type { BaseRecord } from '../records.js';

export type TranscriptChange = { readonly action: 'append'; readonly start: number; readonly end: number } | { readonly action: 'segment'; readonly previousStart: number; readonly start: number; readonly end: number };

export interface TranscriptRecord extends BaseRecord<TranscriptChange> {
  readonly transcriptId: string;
  /** The source change this evidence records. */
  readonly revision: number;
  readonly occurredAt: string;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
}
