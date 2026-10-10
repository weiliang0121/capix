import type { Message } from '../content/message.js';
import type { ModelSettings } from './settings.js';
import type { MessageLocator, TranscriptRangeLocator, TranscriptSnapshot } from '../content/transcript.js';

/** A public service diagnosis, independent of private runtime errors and observation records. */
export interface ConversationFailure {
  readonly code: string;
  readonly message: string;
}

/** Correlation only: the identifier does not promise idempotency or persistence. */
export interface ConversationSubmissionRequest {
  readonly submissionId: string;
  readonly input: ConversationRequest;
}

/** Cumulative service facts. The revision belongs to this projection, not to a connection or invocation. */
export interface ConversationSubmissionSnapshot {
  readonly submissionId: string;
  readonly revision: number;
  readonly input?: TranscriptRangeLocator;
  readonly answer?: MessageLocator;
  readonly executions: readonly { readonly contextId: string }[];
  readonly result?: { readonly status: 'completed' } | { readonly status: 'failed' | 'rejected'; readonly error: ConversationFailure };
  readonly integrity: { readonly status: 'complete' } | { readonly status: 'incomplete'; readonly error: ConversationFailure };
}

export interface ConversationRequest {
  messages: Message[];
  contextBudget?: number;
}
export interface ConfigurationResponse extends ModelSettings {
  configured: boolean;
}
export interface TranscriptResponse extends TranscriptSnapshot {}
export interface ErrorResponse {
  error: string;
  code?: string;
}
