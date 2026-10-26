import type { TranscriptRangeLocator } from '@capix/protocol';
import { ResourceRecord, type RecordBook } from '@capix/records';

import { isTaskRecord } from './calls.js';

/** The resource owns this detail contract. Records never retain a live collection. */
export function executionTranscript(book: RecordBook, executionId: string): TranscriptRangeLocator | undefined {
  const execution = book.get(executionId);
  if (!isTaskRecord(execution)) return;
  for (const id of execution.childIds) {
    const record = book.get(id);
    if (record instanceof ResourceRecord && record.parentId === executionId && record.access === 'transcript.fixedRange' && record.phase === 'available') return record.value as TranscriptRangeLocator;
  }
}
