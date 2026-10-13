import type { MessageLocator } from '../content/transcript.js';
import type { ConversationSubmissionSnapshot, ConversationSubmissionUpdate } from './delivery.js';

/** A disposable answer candidate. Its text is never a formal Transcript message. */
export interface AnswerPreviewSnapshot {
  readonly generation: number;
  readonly revision: number;
  readonly text: string;
  readonly state: 'streaming' | 'received' | 'committed' | 'discarded';
  readonly message?: MessageLocator;
  /** The published candidate may be only a prefix if optional preview delivery stopped. */
  readonly consistency?: 'complete' | 'prefix' | 'mismatch';
  readonly reason?: 'rejected' | 'failed' | 'cancelled';
}

export type AnswerPreviewChange = { readonly generation: number; readonly revision: number } & ({ readonly kind: 'started' } | { readonly kind: 'appended'; readonly offset: number; readonly text: string } | { readonly kind: 'received' } | { readonly kind: 'committed'; readonly message: MessageLocator; readonly consistency: 'complete' | 'prefix' | 'mismatch' } | { readonly kind: 'discarded'; readonly reason: 'rejected' | 'failed' | 'cancelled' });

/** Queries and the first feedback frame carry a complete current preview baseline. */
export interface ConversationSubmissionBaseline {
  readonly type: 'baseline';
  readonly submission: ConversationSubmissionSnapshot;
  readonly preview?: AnswerPreviewSnapshot;
}

/** Process-local active work for a conversation. Absence does not settle any previously known submission. */
export interface ConversationSubmissionDiscovery {
  readonly conversationId: string;
  readonly transcriptId: string;
  readonly submission?: ConversationSubmissionBaseline;
}

export type ConversationSubmissionFrame = ConversationSubmissionBaseline | ConversationSubmissionUpdate | { readonly type: 'answer'; readonly conversationId: string; readonly submissionId: string; readonly change: AnswerPreviewChange };
