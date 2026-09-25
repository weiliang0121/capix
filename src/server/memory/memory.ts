import { randomUUID } from 'node:crypto';
import { isNonBlankString } from '../value/string.js';
import { isNonEmptyArray, hasUniqueItems } from '../value/array.js';
import type { MemoryContent } from '../../shared/memory.js';
import type { Transcript } from '../transcript/transcript.js';

/** A continuing understanding. Its identity survives changes to its content. */
export class Memory {
  readonly id: string = randomUUID();
  #content: MemoryContent;

  constructor(
    readonly transcript: Transcript,
    content: MemoryContent,
  ) {
    this.#content = Memory.prepare(transcript, content);
    Object.freeze(this);
  }

  get topic(): string {
    return this.#content.topic;
  }
  get content(): string {
    return this.#content.content;
  }
  get sourceIndexes(): readonly number[] {
    return this.#content.sourceIndexes;
  }

  update(content: MemoryContent): void {
    this.#content = Memory.prepare(this.transcript, content);
  }

  snapshot(): MemoryContent {
    return this.#content;
  }

  toJSON() {
    return { id: this.id, ...this.#content };
  }

  static prepare(transcript: Transcript, content: MemoryContent): MemoryContent {
    if (!isNonBlankString(content.topic) || !isNonBlankString(content.content) || !isNonEmptyArray(content.sourceIndexes) || !hasUniqueItems(content.sourceIndexes)) throw new TypeError('Memory requires topic, content and unique source indexes');
    for (const index of content.sourceIndexes) transcript.ref(index);
    return Object.freeze({ topic: content.topic, content: content.content, sourceIndexes: Object.freeze([...content.sourceIndexes]) });
  }
}
