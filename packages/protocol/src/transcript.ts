/** JSON message representation for this transport contract, not the entity's public API. */
export interface TranscriptWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A complete baseline. This transport currently starts at position zero. */
export interface TranscriptWireSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly start: 0;
  readonly end: number;
  readonly starts: readonly number[];
  readonly messages: readonly TranscriptWireMessage[];
}

export type TranscriptWireEvent = Readonly<{
  type: 'transcript';
  transcriptId: string;
  revision: number;
  occurredAt: string;
  origin?: Readonly<{ contextId: string }>;
  change: Readonly<{ kind: 'messages-appended'; start: number; messages: readonly TranscriptWireMessage[] }> | Readonly<{ kind: 'segment-started'; previousStart: number; start: number; end: number }>;
}>;

export type TranscriptFrame = { readonly type: 'baseline'; readonly snapshot: TranscriptWireSnapshot } | { readonly type: 'delta'; readonly event: TranscriptWireEvent };
export type TranscriptUpdate = TranscriptFrame | { readonly type: 'error'; readonly code: string; readonly error: string };
