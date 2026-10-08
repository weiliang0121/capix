import { Initializer, bindResources, TranscriptResource, MemoryResource, SelectionUsageResource, type RuntimeContext, type ExecutionResourceSource, type ResourceProvider, type TranscriptRangeReader, type ResourceRequest } from '@capix-observer/runtime';
import type { ModelSettings } from '@capix-observer/protocol';
import { ModelSettingsResource, ModelResource } from '../model/resources.js';
import type { ModelProvider } from '../provider.js';

type Offered<T extends { request(): ResourceRequest<unknown> }> = ReturnType<T['request']> extends ResourceRequest<infer V> ? V : never;
export interface ModelRequestResources {
  readonly settings: Readonly<ModelSettings>;
}
export interface ModelCallResources extends ModelRequestResources {
  readonly timeoutMs: number;
  readonly model: ModelProvider;
}
export interface HistoryResources {
  readonly history: TranscriptRangeReader;
}
export interface ObserverResources extends ModelCallResources, HistoryResources {}
export interface MemoryWriteResources {
  readonly memoryWriter: Offered<typeof MemoryResource.apply>;
}
export interface ObserverExecutionResources extends ObserverResources, MemoryWriteResources {
  readonly memories: Offered<typeof MemoryResource.snapshot>;
  readonly messages: Offered<typeof TranscriptResource.append>;
  readonly selectionUsage: Offered<typeof SelectionUsageResource.record>;
}

export const observerExecutionRequests = Object.freeze({
  settings: ModelSettingsResource.snapshot.request(),
  timeoutMs: ModelSettingsResource.timeout.request(),
  history: TranscriptResource.fixedRange.request(),
  model: ModelResource.invoke.request(),
  memories: MemoryResource.snapshot.request(),
  memoryWriter: MemoryResource.apply.request(),
  messages: TranscriptResource.append.request(),
  selectionUsage: SelectionUsageResource.record.request(),
});
export const observerEntryRequests = Object.freeze({
  settings: ModelSettingsResource.snapshot.request(),
  memories: MemoryResource.snapshot.request(),
  segmentation: TranscriptResource.segmentation.request(),
});

/** The only application assembly site that supplies underlying entities to published offers. */
export class ObserverResourceInitializer {
  readonly model: Initializer<ModelProvider>;
  readonly execution;
  readonly entry;

  constructor(context: RuntimeContext, createModel: () => ModelProvider) {
    this.model = new Initializer(createModel);
    const providers: readonly ResourceProvider<ExecutionResourceSource>[] = [
      ModelSettingsResource.snapshot.provide((source: ExecutionResourceSource) => source.settings),
      ModelSettingsResource.timeout.provide((source: ExecutionResourceSource) => source.settings),
      TranscriptResource.fixedRange.provide((source: ExecutionResourceSource) => {
        if (!source.transcriptRange) throw new Error('Execution Transcript range is required');
        return source.transcriptRange;
      }),
      ModelResource.invoke.provide(() => this.model.get()),
      MemoryResource.snapshot.provide(() => context.memories),
      MemoryResource.apply.provide(() => context.memories),
      TranscriptResource.append.provide(() => context.transcript),
      TranscriptResource.segmentation.provide(() => context.transcript),
      SelectionUsageResource.record.provide(() => context.selectionUsage),
    ];
    this.execution = bindResources<ExecutionResourceSource, ObserverExecutionResources>(observerExecutionRequests, providers);
    this.entry = bindResources(observerEntryRequests, providers);
  }
}

export type ObserverResourceBindings = Pick<ObserverResourceInitializer, 'execution' | 'entry'>;
