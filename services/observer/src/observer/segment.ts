import { TranscriptRangeRef } from '@capix-observer/runtime';

/** Retain up to two consecutive user/assistant pairs immediately before this input. */
export function segmentCandidates(range: TranscriptRangeRef): readonly TranscriptRangeRef[] {
  const starts = [range.end - 1];
  let start = range.end - 1;
  for (let count = 0; count < 2; count++) {
    if (start - 2 < range.start || range.read(start - 1).role !== 'assistant' || range.read(start - 2).role !== 'user') break;
    start -= 2;
    starts.unshift(start);
  }
  // Never reopen archived messages or create another segment at the same boundary.
  return starts.filter((candidate) => candidate > range.start).map((candidate) => new TranscriptRangeRef(range.transcript, candidate, range.end));
}
