import type { MemoryContent } from '../memory.js';
import type { RuntimeRecord } from '../records.js';

export interface MemoryRecordValue {
  readonly action: 'create' | 'update';
  readonly change: string;
  readonly sourceIndexes: readonly number[];
  readonly result: MemoryContent;
}

export interface MemoryRecord extends RuntimeRecord<MemoryRecordValue> {
  readonly memoryId: string;
  readonly executionId: string;
  readonly operationId: string;
}
