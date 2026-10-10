import type { Message } from '../content/message.js';
import type { ModelSettings } from './settings.js';
import type { GenerationOutput } from './generation.js';
import type { TranscriptSnapshot } from '../content/transcript.js';

/** Business delivery uses the invocation Context identity, independent of recording. */
export type ConversationUpdate = { type: 'started'; contextId: string; transcriptId: string; inputIndex: number } | { type: 'answer'; contextId: string; transcriptId: string; index: number; output: GenerationOutput } | { type: 'completed'; contextId: string } | { type: 'error'; error: string; code?: string };

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
