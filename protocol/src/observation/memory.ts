import type { MessageLocator } from '../transcript.js';
import type { MemoryRecord } from '../records/memory.js';

export interface MemoryObservation {
  readonly items: readonly {
    id: string;
    topic: string;
    content: string;
    sources: readonly MessageLocator[];
    records: readonly MemoryRecord[];
  }[];
}
