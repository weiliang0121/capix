import type { ConfigurationResponse, ConversationUpdate, ExecutionRequest, MemoryObservation, ObserverOverview, RuntimeSnapshot, SourceResponse, TranscriptResponse } from '@capix-observer/protocol';

export interface ConversationTransport {
  config(): Promise<ConfigurationResponse>;
  transcript(): Promise<TranscriptResponse>;
  run(request: ExecutionRequest, accept: (update: ConversationUpdate) => void, accepted: () => void): Promise<void>;
}

export interface ObservationTransport {
  overview(): Promise<ObserverOverview>;
  memory(): Promise<MemoryObservation>;
  source(path: string, signal?: AbortSignal): Promise<SourceResponse>;
  execution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot>;
  observe(accept: (snapshot: RuntimeSnapshot) => void, signal: AbortSignal): Promise<void>;
}
