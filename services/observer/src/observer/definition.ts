import type { MemoryInput } from '../operations/memory/input.js';
import { selectionCapacity } from '../operations/history/select.js';
import { segmentCandidates } from './segment.js';
import type { Message, ModelSettings } from '@capix-observer/protocol';
import type { RuntimeDefinition, TranscriptRangeReader } from '@capix-observer/runtime';
import type { ModelProvider } from '../provider.js';
import { SelectHistory } from '../operations/history/select.js';
import { GenerateAnswer } from '../operations/answer/generate.js';
import { ExtractMemory } from '../operations/memory/extract.js';
import { ObserverExecutionDefinition } from './execution.js';
import { observerProviders, type ObserverResourceSource } from './resources.js';

export type ModelInitialization = ModelProvider | (() => ModelProvider);

/** Service content and supplies. It is reusable; no live invocation or runtime is retained. */
export class ObserverRuntimeDefinition implements RuntimeDefinition<ObserverResourceSource, { conversation: ObserverExecutionDefinition }> {
  readonly admit = prepareObserverSegment;
  readonly providers = observerProviders;
  readonly executions;
  constructor(readonly model: ModelInitialization) {
    this.executions = Object.freeze({ conversation: new ObserverExecutionDefinition({ selection: new SelectHistory(), generation: new GenerateAnswer(), extraction: new ExtractMemory() }) });
  }
}

/** Business admission strategy; binding only supplies its declared entry resources. */
function prepareObserverSegment(message: Readonly<Message>, resources: { segmentation: { current(): TranscriptRangeReader; start(index: number): void }; memories: MemoryInput['memories']; settings: ModelSettings }): void {
  const { segmentation, memories, settings } = resources;
  const range = segmentation.current();
  if (range.length === 0 || range.read(range.end - 1) !== message) return;
  const input = { message, memories };
  if (range.length <= 1 || selectionCapacity(input, range, settings).fits) return;
  const next = segmentCandidates(range).find((candidate) => selectionCapacity(input, candidate, settings).fits);
  if (next) segmentation.start(next.start);
}
