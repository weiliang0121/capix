import type { Message } from './types.js';
import type { TranscriptAppendState } from './append.js';

/** Restorable content state; revisions describe mutations, not delivery cursors. */
export interface TranscriptState {
  readonly id: string;
  readonly revision: number;
  readonly starts: readonly number[];
  readonly messages: readonly Readonly<Message>[];
  /** Absent in older content; retained while checkpoint continuation can reference the operation. */
  readonly appends?: readonly TranscriptAppendState[];
}

export type TranscriptCommit = {
  readonly transcriptId: string;
  readonly expectedRevision: number;
  readonly revision: number;
} & ({ readonly kind: 'append'; readonly start: number; readonly messages: readonly Readonly<Message>[]; readonly fixed?: TranscriptAppendState } | { readonly kind: 'start-segment'; readonly start: number });

/**
 * Synchronously commit a validated change before the entity makes it visible.
 * The entity marks port failures and invalid returns as PersistenceError, preserving the cause.
 * A failure does not prove that the store left the change unapplied.
 */
export interface TranscriptPersistence {
  commit(change: TranscriptCommit): undefined;
}
