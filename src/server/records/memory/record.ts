import type { MemoryRecord as MemoryRecordData, MemoryRecordValue } from '../../../shared/records/memory.js';
import { RuntimeRecord } from '../record.js';
import { snapshotValue } from '../value/snapshot.js';

/** An applied change, with its own identity and immutable content. */
export class MemoryRecord extends RuntimeRecord<MemoryRecordValue> implements MemoryRecordData {
  constructor(
    readonly memoryId: string,
    readonly executionId: string,
    readonly operationId: string,
    value: MemoryRecordValue,
  ) {
    super(snapshotValue(value));
    Object.freeze(this);
  }

  override toJSON(): MemoryRecordData {
    return { ...super.toJSON(), memoryId: this.memoryId, executionId: this.executionId, operationId: this.operationId };
  }
}
