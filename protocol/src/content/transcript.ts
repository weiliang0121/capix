import type { Message } from './message.js';
import type { TranscriptEvent } from './changes.js';

/** Identity-only location. It never retains an entity or expands its content. */
export interface MessageLocator {
  readonly transcriptId: string;
  readonly index: number;
}

export interface TranscriptRangeLocator {
  readonly transcriptId: string;
  readonly start: number;
  readonly end: number;
  readonly revision?: number;
}

/** One fixed source version. Revision includes both appends and segment changes. */
export interface TranscriptSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly start: 0;
  readonly end: number;
  readonly starts: readonly number[];
  readonly messages: readonly Readonly<Message>[];
}

export type TranscriptFrame = { readonly type: 'baseline'; readonly snapshot: TranscriptSnapshot } | { readonly type: 'delta'; readonly event: TranscriptEvent };
export type TranscriptUpdate = TranscriptFrame | { readonly type: 'error'; readonly code: string; readonly error: string };
