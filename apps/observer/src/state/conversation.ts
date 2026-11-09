import type { Message, FileTask, FileOutput } from '@weiliang0121/capix-protocol';
import type { SubmissionNotice } from './data.js';

export interface ConversationMessage {
  key: string;
  message: Readonly<Message>;
  index?: number;
  executionId?: string;
  round?: number;
  /** Presentation eligibility only; the message always retains its complete formal content. */
  reveal?: boolean;
}

export type ConversationItem = (ConversationMessage & { readonly kind: 'message' }) | ConversationPendingInput | ConversationResponse;

export interface ConversationPendingInput {
  readonly kind: 'pending-input';
  readonly key: string;
  readonly submissionId: string;
  readonly queueId: string;
  readonly content: string;
  readonly label: string;
}

/** A presentation region, not an assistant message or a new service-side entity. */
export interface ConversationResponse {
  readonly kind: 'response';
  readonly key: string;
  readonly submissionId: string;
  readonly queueId?: string;
  readonly afterInputKey?: string;
  readonly fileTask?: FileTask;
  readonly fileOutput?: FileOutput;
  readonly bodyState: 'unconfirmed' | 'unloaded' | 'pending' | 'available' | 'missing' | 'error';
  readonly body?: ConversationMessage;
  /** Display source; an unaccepted preview never becomes a formal transcript message. */
  readonly content?: ConversationResponseContent;
  readonly process?: ConversationProcess;
  readonly notice?: SubmissionNotice;
}

export interface ConversationResponseContent {
  readonly key: string;
  readonly text: string;
  readonly complete: boolean;
  readonly reveal: boolean;
  readonly provisional: boolean;
}

export interface ConversationProcess {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly notice?: string;
}
