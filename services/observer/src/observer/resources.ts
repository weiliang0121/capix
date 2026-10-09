import { ResourceOffer, type Initializer, TranscriptResource, MemoryResource, SelectionUsageResource, type Transcript, type Memories, type SelectionUsage, type ResourceProvider, type TranscriptRangeRef, type TranscriptRangeReader, type ResourceRequest } from '@capix-observer/runtime';
import type { ConversationUpdate, ModelSettings } from '@capix-observer/protocol';
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
export const ConversationResource = Object.freeze({ delivery: new ResourceOffer('observer.delivery', (deliver: (update: ConversationUpdate) => void, activity) => (update: ConversationUpdate) => activity.runSync('deliver', { input: () => ({ type: update.type }), output: () => null }, () => deliver(update)), 'access', { describe: () => ({ channel: 'conversation' }) }) });
export interface ObserverExecutionResources extends ObserverResources, MemoryWriteResources {
  readonly delivery: (update: ConversationUpdate) => void;
  readonly memories: Offered<typeof MemoryResource.snapshot>;
  readonly messages: Offered<typeof TranscriptResource.append>;
  readonly selectionUsage: Offered<typeof SelectionUsageResource.record>;
}

export const observerExecutionRequests = Object.freeze({
  delivery: ConversationResource.delivery.request(),
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
  messages: TranscriptResource.append.request(),
});

export interface ObserverResourceSource {
  readonly settings: Readonly<ModelSettings>;
  readonly transcriptRange?: TranscriptRangeRef;
  readonly transcript: Transcript;
  readonly memories: Memories;
  readonly selectionUsage: SelectionUsage;
  readonly model: Initializer<ModelProvider>;
  readonly delivery: (update: ConversationUpdate) => void;
}

/** Supply declarations contain no live Runtime or provider instance. */
export const observerProviders: readonly ResourceProvider<ObserverResourceSource>[] = Object.freeze([
  ModelSettingsResource.snapshot.provide((source: ObserverResourceSource) => source.settings),
  ModelSettingsResource.timeout.provide((source: ObserverResourceSource) => source.settings.timeoutMs),
  TranscriptResource.fixedRange.provide((source: ObserverResourceSource) => {
    if (!source.transcriptRange) throw new Error('Execution Transcript range is required');
    return source.transcriptRange;
  }),
  ModelResource.invoke.provide((source: ObserverResourceSource) => source.model.get()),
  MemoryResource.snapshot.provide((source: ObserverResourceSource) => source.memories),
  MemoryResource.apply.provide((source: ObserverResourceSource) => source.memories),
  TranscriptResource.append.provide((source: ObserverResourceSource) => source.transcript),
  TranscriptResource.segmentation.provide((source: ObserverResourceSource) => source.transcript),
  SelectionUsageResource.record.provide((source: ObserverResourceSource) => source.selectionUsage),
  ConversationResource.delivery.provide((source: ObserverResourceSource) => source.delivery),
]);

export type ObserverEntryResources = { [K in keyof typeof observerEntryRequests]: (typeof observerEntryRequests)[K] extends ResourceRequest<infer T> ? T : never };
