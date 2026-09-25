import { uniq } from 'es-toolkit/array';
import type { AssembledContext } from '../../attempt/context/assemble.js';
import type { Memory } from '../../memory/memory.js';
import type { TranscriptRangeRef, MessageRef } from '../../transcript/ref.js';

export interface MemoryInput {
  readonly currentIndexes: readonly number[];
  readonly messages: AssembledContext['selectedMessages'];
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

/** Selected evidence is available to extraction; it is not a claim of actual generation use. */
export function prepareMemoryInput(range: TranscriptRangeRef, response: MessageRef, selectedIndexes: readonly number[], memories: MemoryInput['memories']): MemoryInput {
  const indexes = uniq([...selectedIndexes, range.end - 1]);
  const messages = indexes.sort((a, b) => a - b).map((index) => ({ index, message: range.read(index) }));
  messages.push({ index: response.index, message: response.read() });
  return { currentIndexes: [range.end - 1, response.index], messages, memories };
}
