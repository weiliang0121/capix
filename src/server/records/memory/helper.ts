import { writeRecord } from '../error.js';
import { pick } from 'es-toolkit/object';
import type { MemoryRecordValue } from '../../../shared/records/memory.js';
import type { OperationContext } from '../../context/operation.js';
import type { Memory } from '../../memory/memory.js';
import type { MemoryChange } from '../../memory/change.js';
import type { RecordBook } from '../container/book.js';
import type { RuntimeRecorder } from '../recorder.js';
import { OperationRecord } from '../operation/record.js';
import { ExecutionRecord } from '../execution/record.js';
import { MemoryRecord } from './record.js';

/** Record ownership is resolved here, never added to the live memory or its input. */
export class MemoryRecordHelper {
  static create(book: RecordBook, operationId: string, memoryId: string, value: MemoryRecordValue): MemoryRecord {
    const operation = book.get(operationId);
    const execution = operation instanceof OperationRecord ? book.get(operation.executionId) : undefined;
    if (!(operation instanceof OperationRecord) || !(execution instanceof ExecutionRecord) || operation.status !== 'running' || execution.status !== 'running') throw new Error('Memory changes must be recorded during their operation');
    return book.add(new MemoryRecord(memoryId, execution.id, operation.id, value));
  }

  static capture(recorder: RuntimeRecorder, context: OperationContext, memory: Memory, change: MemoryChange): MemoryRecord {
    return writeRecord(() => {
      const operation = recorder.record(context.id);
      return this.create(recorder.book, operation.id, memory.id, { ...pick(change, ['action', 'change', 'sourceIndexes']), result: memory.snapshot() });
    });
  }

  /** RecordBook preserves actual registration order; no inferred diff or previous-record link. */
  static find(book: RecordBook, memoryId: string): readonly MemoryRecord[] {
    return [...book.values()].filter((record): record is MemoryRecord => record instanceof MemoryRecord && record.memoryId === memoryId);
  }
}
