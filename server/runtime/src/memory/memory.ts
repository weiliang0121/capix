import { randomUUID } from 'node:crypto';
import { isNonBlankString } from '../value/string.js';
import { isNonEmptyArray, hasUniqueItems } from '../value/array.js';
import type { MemoryContent } from '@capix/protocol';
import type { Transcript } from '../transcript/transcript.js';

const contents = new WeakMap<Memory, MemoryContent>();

/** A continuing understanding. Its identity survives changes to its content. */
export class Memory {
  readonly id: string = randomUUID();

  constructor(
    readonly transcript: Transcript,
    content: MemoryContent,
  ) {
    contents.set(this, Memory.prepare(transcript, content));
    Object.freeze(this);
  }

  get topic(): string {
    return contents.get(this)!.topic;
  }
  get content(): string {
    return contents.get(this)!.content;
  }
  get sourceIndexes(): readonly number[] {
    return contents.get(this)!.sourceIndexes;
  }

  snapshot(): MemoryContent {
    return contents.get(this)!;
  }

  toJSON() {
    return { id: this.id, ...contents.get(this)! };
  }

  static prepare(transcript: Transcript, content: MemoryContent): MemoryContent {
    if (!isNonBlankString(content.topic) || !isNonBlankString(content.content) || !isNonEmptyArray(content.sourceIndexes) || !hasUniqueItems(content.sourceIndexes)) throw new TypeError('Memory requires topic, content and unique source indexes');
    for (const index of content.sourceIndexes) transcript.ref(index);
    return Object.freeze({ topic: content.topic, content: content.content, sourceIndexes: Object.freeze([...content.sourceIndexes]) });
  }
}

/** Package-private write path used only after Memories has validated the complete batch. */
export function updateMemory(memory: Memory, content: MemoryContent): void {
  contents.set(memory, Memory.prepare(memory.transcript, content));
}
