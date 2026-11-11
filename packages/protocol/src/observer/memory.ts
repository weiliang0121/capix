import type { MemoryRecord } from '../recording/memory.js';
import type { MemoryViewValue } from '../content/memory.js';

/** Current display values and available change records, without metadata or implied sources. */
export interface MemoryObservation {
  readonly items: readonly {
    readonly id: string;
    readonly value: MemoryViewValue;
    readonly records: readonly MemoryRecord[];
  }[];
}
