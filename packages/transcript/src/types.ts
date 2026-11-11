export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** Identity-only location. It never retains an entity or expands its content. */
export interface MessageLocator {
  readonly transcriptId: string;
  readonly index: number;
}

export interface TranscriptRangeLocator {
  readonly transcriptId: string;
  readonly start: number;
  readonly end: number;
  readonly revision?: number;
}

/** One fixed source version. Revision includes both appends and segment changes. */
export interface TranscriptSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly start: 0;
  readonly end: number;
  readonly starts: readonly number[];
  readonly messages: readonly Readonly<Message>[];
}
