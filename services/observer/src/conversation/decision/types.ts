import type { FileReceipt, GenerationOutput } from '@capix/protocol';
import type { OperationDefinition } from '@capix/server-runtime';
import type { RequestUnderstandingInput } from '../operations/request/input.js';
import type { FilePreflightInput, FilePreflightOutput } from '../operations/preflight/types.js';

export interface ConversationCapabilityArguments {
  readonly checkFile: FilePreflightInput;
  readonly answer: Record<string, never>;
  readonly document: Record<string, never>;
  readonly save: Record<string, never>;
}
export type ConversationCapabilityName = keyof ConversationCapabilityArguments;
export type ConversationDecision = { [K in ConversationCapabilityName]: { readonly kind: 'invoke'; readonly capability: K; readonly arguments: ConversationCapabilityArguments[K] } }[ConversationCapabilityName] | { readonly kind: 'finish'; readonly conclusion: { readonly kind: 'settled' } | { readonly kind: 'clarify'; readonly question: string } | { readonly kind: 'unsupported'; readonly explanation: string } };

export interface ConversationCapabilityOffer {
  readonly name: ConversationCapabilityName;
  readonly description: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface ConversationDecisionFeedback {
  readonly code: string;
  readonly message: string;
}
export type ConversationDelivery = { readonly capability: 'checkFile'; readonly output: FilePreflightOutput } | { readonly capability: 'answer' | 'document'; readonly output: GenerationOutput } | { readonly capability: 'save'; readonly output: FileReceipt };

/** Per-call, accepted business facts. It contains no live entity or invocation handles. */
export interface ConversationDecisionProgress {
  readonly file?: Extract<FilePreflightOutput, { kind: 'ready' }>;
  readonly answer?: GenerationOutput;
  readonly saved?: FileReceipt;
}
export interface ConversationDecisionInput {
  readonly request: RequestUnderstandingInput;
  readonly progress: ConversationDecisionProgress;
  readonly latest?: ConversationDelivery;
  readonly available: readonly ConversationCapabilityOffer[];
  readonly feedback?: ConversationDecisionFeedback;
}

/** The execution consumes the decision contract, independently of how the operation implements it. */
export type ConversationDecisionDefinition = OperationDefinition<ConversationDecisionInput, ConversationDecision, any, any>;
