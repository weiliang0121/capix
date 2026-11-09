import type { TranscriptRangeLocator } from '@weiliang0121/capix-protocol';

/** The immutable extent of one committed append, never a client submission receipt. */
export interface TranscriptAppendProgress extends TranscriptRangeLocator {}
