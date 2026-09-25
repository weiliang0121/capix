import type { ConfigurationResponse, ExecutionRequest, MemoryObservation, ObserverOverview, RuntimeSnapshot, SourceResponse, TranscriptResponse } from '@capix-observer/protocol';

export interface ClientTransport {
  config(): Promise<ConfigurationResponse>;
  overview(): Promise<ObserverOverview>;
  transcript(): Promise<TranscriptResponse>;
  memory(): Promise<MemoryObservation>;
  source(path: string, signal?: AbortSignal): Promise<SourceResponse>;
  execution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot>;
  run(request: ExecutionRequest, accept: (snapshot: RuntimeSnapshot) => void, accepted: () => void): Promise<void>;
}
