import type { ConfigurationResponse, ConversationUpdate, ExecutionRequest, MemoryObservation, ObserverOverview, RuntimeSnapshot, ObservationFrame, SourceResponse, TranscriptResponse, TranscriptFrame } from '@capix-observer/protocol';

export interface ConversationTransport {
  config(): Promise<ConfigurationResponse>;
  run(request: ExecutionRequest, accept: (update: ConversationUpdate) => void, accepted: () => void): Promise<void>;
}

export interface ObservationTransport {
  overview(): Promise<ObserverOverview>;
  memory(): Promise<MemoryObservation>;
  source(path: string, signal?: AbortSignal): Promise<SourceResponse>;
  execution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot>;
  observe(accept: (frame: ObservationFrame) => void, signal: AbortSignal): Promise<void>;
}

/** Entity content can be loaded and synchronized independently of observation. */
export interface TranscriptTransport {
  transcript(id?: string, signal?: AbortSignal): Promise<TranscriptResponse>;
  observeTranscript(id: string | undefined, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void>;
}
