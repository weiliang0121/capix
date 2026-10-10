import type { MemoryInput } from './operations/memory/input.js';
import { selectionCapacity } from './operations/history/select.js';
import { segmentCandidates } from './segment.js';
import type { Message, ModelSettings } from '@capix/protocol';
import type { TranscriptRangeReader } from '@capix/server-runtime/content';

/** Business admission strategy; binding only supplies its declared entry resources. */
export function prepareConversationSegment(message: Readonly<Message>, resources: { segmentation: { current(): TranscriptRangeReader; start(index: number): void }; memories: MemoryInput['memories']; settings: ModelSettings }): void {
  const { segmentation, memories, settings } = resources;
  const range = segmentation.current();
  if (range.length === 0 || range.read(range.end - 1) !== message) return;
  const input = { message, memories };
  if (range.length <= 1 || selectionCapacity(input, range, settings).fits) return;
  const next = segmentCandidates(range).find((candidate) => selectionCapacity(input, candidate, settings).fits);
  if (next) segmentation.start(next.start);
}
