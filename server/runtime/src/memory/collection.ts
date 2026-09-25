import type { Transcript } from '../transcript/transcript.js';
import type { Memory } from './memory.js';

/** Owns current memory instances; does not perform updates or write records. */
export class MemoryCollection {
  readonly #items = new Map<string, Memory>();

  get(id: string): Memory | undefined {
    return this.#items.get(id);
  }

  values(transcript: Transcript): readonly Memory[] {
    return [...this.#items.values()].filter((memory) => memory.transcript === transcript);
  }

  add(memory: Memory): Memory {
    if (this.#items.has(memory.id)) throw new Error('Memory ID already exists');
    this.#items.set(memory.id, memory);
    return memory;
  }
}
