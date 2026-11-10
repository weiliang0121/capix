import type { MemoryContent, MemoryObservation } from '@weiliang0121/capix-protocol';
import type { RecordBook } from '../book.js';
import { MemoryRecord } from './record.js';

/** Project current memory content together with its available change records. */
export function observeMemory(collection: { readonly transcript: { readonly id: string }; values(): readonly (MemoryContent & { readonly id: string })[] }, book: RecordBook): MemoryObservation {
  const records = new Map<string, MemoryRecord[]>();
  for (const record of book.values()) {
    if (!(record instanceof MemoryRecord)) continue;
    const own = records.get(record.memoryId);
    if (own) own.push(record);
    else records.set(record.memoryId, [record]);
  }
  return {
    items: collection.values().map((memory) => ({
      id: memory.id,
      topic: memory.topic,
      content: memory.content,
      sources: memory.sourceIndexes.map((index) => ({ transcriptId: collection.transcript.id, index })),
      ...(memory.sourceResults ? { sourceResults: memory.sourceResults } : {}),
      records: (records.get(memory.id) ?? []).map((record) => record.toJSON()),
    })),
  };
}
