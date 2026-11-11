import type { MemoryRecordContent, MemoryRecordObservation } from '../data/index.js';
import type { RecordBook } from '../book.js';
import { MemoryRecord } from './record.js';

/** Project current display content together with this collection's available change records.
 * Unknown metadata is intentionally omitted, consistently with memoryRecord's incremental projection.
 */
export function observeMemory(collection: { readonly id: string; values(): readonly { readonly id: string; readonly value: MemoryRecordContent }[] }, book: RecordBook): MemoryRecordObservation {
  const records = new Map<string, MemoryRecord[]>();
  for (const record of book.values()) {
    if (!(record instanceof MemoryRecord) || record.memoriesId !== collection.id) continue;
    const own = records.get(record.memoryId);
    if (own) own.push(record);
    else records.set(record.memoryId, [record]);
  }
  return {
    items: collection.values().map((memory) => ({ id: memory.id, value: { content: memory.value.content }, records: (records.get(memory.id) ?? []).map((record) => record.toJSON()) })),
  };
}
