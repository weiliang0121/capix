import type { ProgressChannel } from '@capix/server-runtime';

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
  historyIndexes: number[];
}
export interface ModelRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  response_format: { type: 'json_object' };
  thinking: { type: 'disabled' };
  max_tokens: number;
  stream: boolean;
}
export interface ModelOutput {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}
