import type { MemoryContent } from '../memory.js';
import type { BaseRecord } from '../records.js';

export interface MemoryRecordValue {
  readonly action: 'create' | 'update';
  readonly change: string;
  readonly sourceIndexes: readonly number[];
  readonly result: MemoryContent;
}

export interface MemoryRecord extends BaseRecord<MemoryRecordValue> {
  readonly memoryId: string;
  /** Formal changes are ordered within one Memories instance. */
  readonly memoriesId: string;
  readonly sequence: number;
  readonly contextId?: string;
  readonly callId?: string;
  readonly executionId?: string;
  readonly operationId?: string;
}
