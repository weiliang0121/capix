import { MessageRef, TranscriptRangeRef } from './ref.js';

/** JSON replacer for the live observation response. Reads facts without creating records. */
export function observeTranscript(_key: string, value: unknown): unknown {
  if (value instanceof MessageRef) return { index: value.index, message: value.read() };
  if (value instanceof TranscriptRangeRef) return { start: value.start, end: value.end, messages: value.refs() };
  return value;
}
