import type { ConfigurationResponse, ConversationSubmissionSnapshot, ConversationSubmissionRequest, MemoryObservation, ObserverOverview, ExecutionRecordSnapshot, ObservationFrame, SourceResponse, TranscriptResponse, TranscriptFrame } from '@capix/protocol';

export interface ConversationTransport {
  config(): Promise<ConfigurationResponse>;
  read(id: string, signal?: AbortSignal): Promise<ConversationSubmissionSnapshot>;
  cancel(id: string, signal?: AbortSignal): Promise<ConversationSubmissionSnapshot>;
  submit(request: ConversationSubmissionRequest, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void>;
  follow(id: string, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void>;
}

export interface ObservationTransport {
  overview(): Promise<ObserverOverview>;
  memory(): Promise<MemoryObservation>;
  source(path: string, signal?: AbortSignal): Promise<SourceResponse>;
  execution(id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot>;
  observe(accept: (frame: ObservationFrame) => void, signal: AbortSignal): Promise<void>;
}

/** Entity content can be loaded and synchronized independently of observation. */
export interface TranscriptTransport {
  transcript(id?: string, signal?: AbortSignal): Promise<TranscriptResponse>;
  observeTranscript(id: string | undefined, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void>;
}
