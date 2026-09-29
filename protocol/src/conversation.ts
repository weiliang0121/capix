import type { Message } from './message.js';
import type { ModelSettings } from './settings.js';
import type { GenerationOutput } from './generation.js';

/** Business delivery uses the invocation Context identity, independent of recording. */
export type ConversationUpdate = { type: 'started'; contextId: string; inputIndex: number } | { type: 'answer'; contextId: string; index: number; output: GenerationOutput } | { type: 'completed'; contextId: string } | { type: 'error'; error: string; code?: string };

export interface ExecutionRequest {
  messages: Message[];
  contextBudget?: number;
}
export interface ConfigurationResponse extends ModelSettings {
  configured: boolean;
}
export interface TranscriptResponse {
  messages: readonly Readonly<Message>[];
}
export interface ErrorResponse {
  error: string;
  code?: string;
}
