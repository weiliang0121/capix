import { uniq } from 'es-toolkit/array';
import type { AssembledContext } from '../../attempt/context/assemble.js';
import type { Memory, TranscriptRangeReader } from '@capix-observer/runtime';

export interface MemoryInput {
  readonly currentIndexes: readonly number[];
  readonly messages: AssembledContext['selectedMessages'];
  readonly memories: readonly ReturnType<Memory['toJSON']>[];
}

/** Selected evidence is available to extraction; it is not a claim of actual generation use. */
export function prepareMemoryInput(range: TranscriptRangeReader, response: AssembledContext['selectedMessages'][number], selectedIndexes: readonly number[], memories: MemoryInput['memories']): MemoryInput {
  const indexes = uniq([...selectedIndexes, range.end - 1]);
  const messages = indexes.sort((a, b) => a - b).map((index) => ({ index, message: range.read(index) }));
  messages.push({ index: response.index, message: response.message });
  return { currentIndexes: [range.end - 1, response.index], messages, memories };
}
