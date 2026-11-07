import type { ProgressChannel } from '@capix/changes';

export type Purpose = 'selection' | 'understanding' | 'answer' | 'memory';
export type ModelInitialization = ModelProvider | (() => ModelProvider);
/** Provider text, before any business JSON or answer interpretation. */
export interface ModelTextDelta {
  readonly text: string;
}
export interface ModelProvider {
  /** A known provider condition requiring replacement/reconfiguration; reading it never probes the model. */
  readonly unavailable?: { readonly code: string; readonly message: string };
  invoke(request: ModelRequest, purpose: Purpose, signal: AbortSignal, progress?: ProgressChannel<ModelTextDelta>): Promise<ModelOutput>;
}
export interface Selection {
  readonly historyIndexes: readonly number[];
}
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[];
  readonly response_format: { readonly type: 'json_object' };
  readonly thinking: { readonly type: 'disabled' };
  readonly max_tokens: number;
  readonly stream: boolean;
}
export interface ModelOutput {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly finishReason: string;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number } | null;
}
