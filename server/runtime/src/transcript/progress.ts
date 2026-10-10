import type { TranscriptRangeLocator } from '@capix/protocol';

/** The immutable extent of one committed append, never a client submission receipt. */
export interface TranscriptAppendProgress extends TranscriptRangeLocator {}
