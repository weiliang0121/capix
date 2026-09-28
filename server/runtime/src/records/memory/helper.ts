import type { MemoryRecordValue } from '@capix-observer/protocol';
import type { ChangeSource } from '../source.js';
import type { RecordBook } from '../container/book.js';
import { MemoryRecord } from './record.js';

/** Record ownership is resolved here, never added to the live memory or its input. */
export class MemoryRecordHelper {
  static create(memoryId: string, value: MemoryRecordValue, source?: ChangeSource): MemoryRecord {
    return new MemoryRecord(memoryId, source?.executionId, source?.operationId, value, source?.contextId, source?.callId);
  }

  /** RecordBook preserves actual registration order; no inferred diff or previous-record link. */
  static find(book: RecordBook, memoryId: string): readonly MemoryRecord[] {
    return [...book.values()].filter((record): record is MemoryRecord => record instanceof MemoryRecord && record.memoryId === memoryId);
  }
}
