import type { TranscriptRangeLocator } from './types.js';

/** The immutable extent of one committed append, never a client submission receipt. */
export interface TranscriptAppendProgress extends TranscriptRangeLocator {}
