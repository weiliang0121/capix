import type { Message } from '../content/message.js';
import type { ModelSettings } from './settings.js';
import type { MessageLocator, TranscriptRangeLocator, TranscriptSnapshot } from '../content/transcript.js';
import type { ConversationActivities, ConversationActivityChange, ConversationStage } from './activity.js';
import type { FileTask, FileOutput } from './files.js';
import type { ConversationTask } from './task.js';

/** A public service diagnosis, independent of private runtime errors and observation records. */
export interface ConversationFailure {
  readonly code: string;
  readonly message: string;
}

/** Current service admission conditions; a ready response does not reserve the next run. */
export type ConversationAdmission = { readonly conversationId: string; readonly transcriptId: string } & ({ readonly status: 'ready' } | { readonly status: 'busy' } | { readonly status: 'unavailable'; readonly error: ConversationFailure });

/** Correlation only: the identifier does not promise idempotency or persistence. */
export interface ConversationSubmissionRequest {
  readonly conversationId: string;
  readonly submissionId: string;
  readonly input: ConversationRequest;
}

/** Cumulative service facts. The revision belongs to this projection, not to a connection or invocation. */
export interface ConversationSubmissionSnapshot {
  readonly conversationId: string;
  readonly submissionId: string;
  readonly revision: number;
  readonly input?: TranscriptRangeLocator;
  readonly answer?: MessageLocator;
  readonly executions: readonly { readonly contextId: string }[];
  /** Optional, independently complete progress projection. It never determines the submission result. */
  readonly activities?: ConversationActivities;
  /** Optional current processing stage; never determines the final submission result. */
  readonly stage?: ConversationStage;
  /** Fixed after parent acceptance; a proposal or explicit input alone is not this fact. */
  readonly task?: ConversationTask;
  readonly fileOutput?: FileOutput;
  /** The service accepted a stop request; this does not establish a terminal result. */
  readonly cancelRequested?: true;
  /** Admission conditions at publication time, independent of this submission's immutable result. */
  readonly admission?: ConversationAdmission;
  /** retry is only granted for definite non-admission under temporary service conditions. */
  readonly result?: { readonly status: 'completed' | 'cancelled' } | { readonly status: 'failed'; readonly error: ConversationFailure } | { readonly status: 'rejected'; readonly error: ConversationFailure; readonly retry?: 'admission' };
  readonly integrity: { readonly status: 'complete' } | { readonly status: 'incomplete'; readonly error: ConversationFailure };
}

/** Facts installed during a revision interval, captured by their producer rather than snapshot comparison. */
export interface ConversationSubmissionChange {
  readonly input?: TranscriptRangeLocator;
  readonly answer?: MessageLocator;
  /** Newly attached executions, in attachment order. Overlapping baselines may already contain a prefix. */
  readonly executions?: readonly { readonly contextId: string }[];
  readonly activities?: ConversationActivityChange;
  readonly stage?: ConversationStage;
  readonly task?: ConversationTask;
  readonly fileOutput?: FileOutput;
  readonly cancelRequested?: true;
  /** An absent field is unchanged; null explicitly removes a previous admission hint. */
  readonly admission?: ConversationAdmission | null;
  readonly result?: ConversationSubmissionSnapshot['result'];
  readonly integrity?: ConversationSubmissionSnapshot['integrity'];
}

export interface ConversationSubmissionUpdate {
  readonly type: 'submission';
  readonly conversationId: string;
  readonly submissionId: string;
  readonly fromRevision: number;
  readonly revision: number;
  readonly change: ConversationSubmissionChange;
}

export interface ConversationRequest {
  messages: Message[];
  contextBudget?: number;
  fileTask?: FileTask;
}
export interface ConfigurationResponse extends ModelSettings {
  configured: boolean;
  files?: { readonly maxReadBytes: number; readonly maxWriteBytes: number };
}
export interface TranscriptResponse extends TranscriptSnapshot {}
export interface ErrorResponse {
  error: string;
  code?: string;
}
