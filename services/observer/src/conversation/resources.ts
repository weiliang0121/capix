import { type Initializer, type ResourceProvider, type ResourceRequest, type ProgressReceiver } from '@capix/server-runtime';
import { TranscriptResource, MemoryResource, SelectionUsageResource, type Transcript, type Memories, type SelectionUsage, type TranscriptRangeRef, type TranscriptRangeReader, type TranscriptAppendProgress } from '@capix/server-runtime/content';
import type { ModelSettings } from '@capix/protocol';
import { ModelSettingsResource, ModelResource } from './model/resources.js';
import type { ModelProvider, ModelInvocation } from './model/types.js';

type Offered<Offer extends { request(): ResourceRequest<unknown> }> = ReturnType<Offer['request']> extends ResourceRequest<infer Value> ? Value : never;
export interface ModelRequestResources {
  readonly settings: Readonly<ModelSettings>;
}
export interface ModelCallResources extends ModelRequestResources {
  readonly timeoutMs: number;
  readonly model: ModelInvocation;
}
export interface HistoryResources {
  readonly history: TranscriptRangeReader;
}
export interface ConversationResources extends ModelCallResources, HistoryResources {}
export interface MemoryWriteResources {
  readonly memoryWriter: Offered<typeof MemoryResource.apply>;
}
export interface ConversationExecutionResources extends ConversationResources, MemoryWriteResources {
  readonly memories: Offered<typeof MemoryResource.snapshot>;
  readonly messages: Offered<typeof TranscriptResource.append>;
  readonly selectionUsage: Offered<typeof SelectionUsageResource.record>;
}

export const conversationExecutionRequests = Object.freeze({
  settings: ModelSettingsResource.snapshot.request(),
  timeoutMs: ModelSettingsResource.timeout.request(),
  history: TranscriptResource.fixedRange.request(),
  model: ModelResource.invoke.request(),
  memories: MemoryResource.snapshot.request(),
  memoryWriter: MemoryResource.apply.request(),
  messages: TranscriptResource.append.request(),
  selectionUsage: SelectionUsageResource.record.request(),
});
export const conversationEntryRequests = Object.freeze({
  settings: ModelSettingsResource.snapshot.request(),
  memories: MemoryResource.snapshot.request(),
  segmentation: TranscriptResource.segmentation.request(),
  messages: TranscriptResource.append.request(),
});

export interface ConversationResourceSource {
  readonly settings: Readonly<ModelSettings>;
  readonly transcriptRange?: TranscriptRangeRef;
  readonly transcript: Transcript;
  readonly messageProgress?: ProgressReceiver<TranscriptAppendProgress>;
  readonly memories: Memories;
  readonly selectionUsage: SelectionUsage;
  readonly model: Initializer<ModelProvider>;
}

/** Supply declarations contain no live Runtime or provider instance. */
export const conversationProviders: readonly ResourceProvider<ConversationResourceSource>[] = Object.freeze([
  ModelSettingsResource.snapshot.provide((source: ConversationResourceSource) => source.settings),
  ModelSettingsResource.timeout.provide((source: ConversationResourceSource) => source.settings.timeoutMs),
  TranscriptResource.fixedRange.provide((source: ConversationResourceSource) => {
    if (!source.transcriptRange) throw new Error('Execution Transcript range is required');
    return source.transcriptRange;
  }),
  ModelResource.invoke.provide((source: ConversationResourceSource) => source.model.get()),
  MemoryResource.snapshot.provide((source: ConversationResourceSource) => source.memories),
  MemoryResource.apply.provide((source: ConversationResourceSource) => source.memories),
  TranscriptResource.append.provide((source: ConversationResourceSource) => ({ transcript: source.transcript, progress: source.messageProgress })),
  TranscriptResource.segmentation.provide((source: ConversationResourceSource) => source.transcript),
  SelectionUsageResource.record.provide((source: ConversationResourceSource) => source.selectionUsage),
]);

export type ConversationEntryResources = { [Alias in keyof typeof conversationEntryRequests]: (typeof conversationEntryRequests)[Alias] extends ResourceRequest<infer Value> ? Value : never };
