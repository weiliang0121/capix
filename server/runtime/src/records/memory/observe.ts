import type { MemoryObservation } from '@capix/protocol';
import type { RecordBook } from '../container/book.js';
import { MemoryRecordHelper } from './helper.js';
import type { Memories } from '../../memory/memories.js';

/** Project current memory content together with its available change records. */
export function observeMemory(collection: Memories, book: RecordBook): MemoryObservation {
  return {
    items: collection.values().map((memory) => ({
      id: memory.id,
      topic: memory.topic,
      content: memory.content,
      sources: memory.sourceIndexes.map((index) => ({ transcriptId: collection.transcript.id, index })),
      records: MemoryRecordHelper.find(book, memory.id).map((record) => record.toJSON()),
    })),
  };
}
