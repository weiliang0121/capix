import type { MemoryRecordValue } from '@capix-observer/protocol';
import type { RecordBook } from '../container/book.js';
import { MemoryRecord, type MemoryDefinition } from './record.js';

/** Record ownership is resolved here, never added to the live memory or its input. */
export class MemoryRecordHelper {
  static create(definition: MemoryDefinition, value: MemoryRecordValue): MemoryRecord {
    return new MemoryRecord(definition, value);
  }

  /** RecordBook preserves actual registration order; no inferred diff or previous-record link. */
  static find(book: RecordBook, memoryId: string): readonly MemoryRecord[] {
    return [...book.values()].filter((record): record is MemoryRecord => record instanceof MemoryRecord && record.memoryId === memoryId);
  }
}
