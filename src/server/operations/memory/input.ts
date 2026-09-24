import type { GenerationInput } from '../context/assemble.js';
import type { Memory } from '../../memory/memory.js';
import type { TranscriptRangeRef, MessageRef } from '../../transcript/ref.js';

export interface MemoryInput {
  readonly currentIndexes: readonly number[];
  readonly messages: GenerationInput['selectedMessages'];
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

/** Selected evidence is available to extraction; it is not a claim of actual generation use. */
export function prepareMemoryInput(range: TranscriptRangeRef, response: MessageRef, selected: GenerationInput['selectedMessages'], memories: readonly Memory[]): MemoryInput {
  const indexes = new Set([...selected.map((item) => item.index), ...memories.flatMap((memory) => memory.sourceIndexes), range.end - 1]);
  const messages = [...indexes].sort((a, b) => a - b).map((index) => ({ index, message: range.read(index) }));
  messages.push({ index: response.index, message: response.read() });
  return { currentIndexes: [range.end - 1, response.index], messages, memories: memories.map((memory) => memory.toJSON()) };
}
