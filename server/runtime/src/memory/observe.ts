import type { MemoryObservation } from '@capix-observer/protocol';
import type { RecordBook } from '../records/container/book.js';
import { MemoryRecordHelper } from '../records/memory/helper.js';
import type { Memories } from './memories.js';

export function observeMemory(collection: Memories, book: RecordBook): MemoryObservation {
  return {
    items: collection.values().map((memory) => ({
      id: memory.id,
      topic: memory.topic,
      content: memory.content,
      sources: memory.sourceIndexes.map((index) => ({ index, message: collection.transcript.get(index)! })),
      records: MemoryRecordHelper.find(book, memory.id).map((record) => record.toJSON()),
    })),
  };
}
