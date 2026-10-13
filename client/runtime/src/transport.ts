import type { ConversationDescriptor, ConversationListResponse, ConfigurationResponse, ConversationAdmission, ConversationSubmissionSnapshot, ConversationSubmissionRequest, MemoryObservation, ObserverOverview, ExecutionRecordSnapshot, ObservationFrame, SourceResponse, TranscriptResponse, TranscriptFrame } from '@capix/protocol';

export interface ConversationTransport {
  config(): Promise<ConfigurationResponse>;
  conversations(signal?: AbortSignal): Promise<ConversationListResponse>;
  createConversation(signal?: AbortSignal): Promise<ConversationDescriptor>;
  conversation(id: string, signal?: AbortSignal): Promise<ConversationDescriptor>;
  admission(conversationId: string, signal?: AbortSignal): Promise<ConversationAdmission>;
  read(id: string, signal?: AbortSignal): Promise<ConversationSubmissionSnapshot>;
  cancel(id: string, signal?: AbortSignal): Promise<ConversationSubmissionSnapshot>;
  submit(request: ConversationSubmissionRequest, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void>;
  follow(id: string, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void>;
}

export interface ObservationTransport {
  overview(conversationId: string): Promise<ObserverOverview>;
  memory(conversationId: string): Promise<MemoryObservation>;
  source(path: string, signal?: AbortSignal): Promise<SourceResponse>;
  execution(conversationId: string, id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot>;
  observe(conversationId: string, accept: (frame: ObservationFrame) => void, signal: AbortSignal): Promise<void>;
}

/** A transport-confirmed interruption eligible for bounded entity reconnection. */
export class TranscriptConnectionError extends Error {
  readonly name = 'TranscriptConnectionError';
}

/** Entity content can be loaded and synchronized independently of observation. */
export interface TranscriptTransport {
  transcript(id: string, signal?: AbortSignal): Promise<TranscriptResponse>;
  observeTranscript(id: string, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void>;
}
