import type { MemoryObservation } from '../../shared/observation/memory.js';
import type { RecordBook } from '../records/container/book.js';
import { MemoryRecordHelper } from '../records/memory/helper.js';
import type { Transcript } from '../transcript/transcript.js';
import type { MemoryCollection } from './collection.js';

export function observeMemory(collection: MemoryCollection, transcript: Transcript, book: RecordBook): MemoryObservation {
  return {
    items: collection.values(transcript).map((memory) => ({
      id: memory.id,
      topic: memory.topic,
      content: memory.content,
      sources: memory.sourceIndexes.map((index) => ({ index, message: transcript.get(index)! })),
      records: MemoryRecordHelper.find(book, memory.id).map((record) => record.toJSON()),
    })),
  };
}
