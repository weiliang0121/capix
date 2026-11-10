import type { MessageLocator } from '../content/transcript.js';
import type { MemoryRecord } from '../recording/memory.js';
import type { MemoryResultSource } from '../content/memory.js';

export interface MemoryObservation {
  readonly items: readonly {
    id: string;
    topic: string;
    content: string;
    sources: readonly MessageLocator[];
    sourceResults?: readonly MemoryResultSource[];
    records: readonly MemoryRecord[];
  }[];
}
