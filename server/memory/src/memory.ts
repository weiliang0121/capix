import { randomUUID } from 'node:crypto';
import { isNonBlankString, isNonEmptyArray, hasUniqueItems, isObject } from './validation.js';
import type { MemoryContent } from '@capix/protocol';
import type { Transcript } from '@capix/transcript';
import { prepareMemoryResultSources } from './source.js';
import type { MemoryState } from './persistence.js';

const contents = new WeakMap<Memory, { readonly id: string; content: MemoryContent }>();

/** A continuing understanding. Its identity survives changes to its content. */
export class Memory {
  constructor(
    readonly transcript: Transcript,
    content: MemoryContent,
  ) {
    contents.set(this, { id: randomUUID(), content: Memory.prepare(transcript, content) });
    Object.freeze(this);
  }

  get id(): string {
    return contents.get(this)!.id;
  }

  get topic(): string {
    return contents.get(this)!.content.topic;
  }
  get content(): string {
    return contents.get(this)!.content.content;
  }
  get sourceIndexes(): readonly number[] {
    return contents.get(this)!.content.sourceIndexes;
  }
  get sourceResults() {
    return contents.get(this)!.content.sourceResults;
  }

  snapshot(): MemoryContent {
    return contents.get(this)!.content;
  }

  toJSON() {
    return { id: this.id, ...contents.get(this)!.content };
  }

  static prepare(transcript: Transcript, content: MemoryContent): MemoryContent {
    if (!isObject(content) || !isNonBlankString(content.topic) || !isNonBlankString(content.content) || !isNonEmptyArray(content.sourceIndexes) || !hasUniqueItems(content.sourceIndexes)) throw new TypeError('Memory requires topic, content and unique source indexes');
    for (const index of content.sourceIndexes) transcript.ref(index);
    const sourceResults = prepareMemoryResultSources(transcript, content.sourceResults);
    return Object.freeze({ topic: content.topic, content: content.content, sourceIndexes: Object.freeze([...content.sourceIndexes]), ...(sourceResults ? { sourceResults } : {}) });
  }
}

/** Package-private write path used only after Memories has validated the complete batch. */
export function updateMemory(memory: Memory, content: MemoryContent): void {
  contents.get(memory)!.content = content;
}

/** Package-private hydration: Memories controls identity uniqueness and source ownership. */
export function restoreMemory(transcript: Transcript, state: MemoryState): Memory {
  if (!isObject(state) || !isNonBlankString(state.id)) throw new TypeError('Invalid persisted memory identity');
  const memory = new Memory(transcript, state);
  contents.set(memory, { id: state.id, content: memory.snapshot() });
  return memory;
}
