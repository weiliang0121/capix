import type { BaseRecord } from './types.js';

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

/** Domain fields shared by subtree projections and stored record entries. */
export function checkTranscriptRecord(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transcript record');
  const record = value as Partial<TranscriptRecord>;
  if (typeof record.transcriptId !== 'string' || !record.transcriptId.trim() || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.occurredAt !== 'string' || !Number.isFinite(Date.parse(record.occurredAt))) throw new Error('Invalid transcript record identity, revision or time');
  const change = record.value;
  if (!change || typeof change !== 'object' || Array.isArray(change) || !Number.isSafeInteger(change.start) || change.start < 0 || !Number.isSafeInteger(change.end) || change.start >= change.end) throw new Error('Invalid transcript record range');
  if (change.action === 'append') return;
  if (change.action !== 'segment' || !Number.isSafeInteger(change.previousStart) || change.previousStart < 0 || change.previousStart >= change.start) throw new Error('Invalid transcript record change');
}
