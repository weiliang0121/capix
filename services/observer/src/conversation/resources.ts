import type { ModelInteractionReader } from './model/resources.js';
import type { ResourceRequest } from '@capix/server-runtime';
import { TranscriptResource, MemoryResource, type TranscriptRangeReader } from '@capix/server-runtime/content';
import type { ModelSettings } from '@capix/protocol';
import { ConversationTaskResource, type TaskSelection } from './decision/selection.js';
import type { ModelInteractionCreator } from './model/interactions.js';
import { ConversationMaterialUsageResource } from './content/usage.js';

type Offered<Offer extends { request(): ResourceRequest<unknown> }> = ReturnType<Offer['request']> extends ResourceRequest<infer Value> ? Value : never;
export interface ModelRequestResources {
  readonly settings: Readonly<ModelSettings>;
}
export interface ModelCallResources extends ModelRequestResources {
  readonly timeoutMs: number;
  readonly modelCreator: ModelInteractionCreator;
  readonly modelReader: ModelInteractionReader;
}
export interface HistoryResources {
  readonly history: TranscriptRangeReader;
}
export interface ConversationResources extends ModelCallResources, HistoryResources {}
export interface MemoryWriteResources {
  readonly memoryWriter: Offered<typeof MemoryResource.apply>;
}
export interface ConversationTaskResources extends HistoryResources {
  readonly messages: Offered<typeof TranscriptResource.append>;
  readonly selectionUsage: Offered<typeof ConversationMaterialUsageResource>;
  readonly tasks: TaskSelection;
}

export const conversationTaskRequests = Object.freeze({
  history: TranscriptResource.fixedRange.request(),
  messages: TranscriptResource.append.request(),
  selectionUsage: ConversationMaterialUsageResource.request(),
  tasks: ConversationTaskResource.request(),
});
export const conversationSceneRequests = Object.freeze({ messages: TranscriptResource.append.request() });
export interface ConversationSceneResources {
  readonly messages: Offered<typeof TranscriptResource.append>;
}
