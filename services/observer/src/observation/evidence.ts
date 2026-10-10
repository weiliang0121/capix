import type { TranscriptRangeLocator } from '@capix/protocol';
import { ResourceRecord, type RecordBook } from '@capix/server-runtime/recording';

/** The resource owns this detail contract. Records never retain a live collection. */
export function executionTranscript(book: RecordBook, executionId: string): TranscriptRangeLocator | undefined {
  const fact = [...book.values()].find((record) => record instanceof ResourceRecord && record.parentId === executionId && record.access === 'transcript.fixedRange' && record.phase === 'available');
  return fact?.value as TranscriptRangeLocator | undefined;
}
