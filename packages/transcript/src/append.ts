import type { Message } from '@weiliang0121/capix-protocol';

/** A binding fixes this identity from one real parent/child reception and declared effect position. */
export interface TranscriptAppendOperation {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly position: string;
}

/** Entity-level request. Business resource views must not accept arbitrary call identities. */
export interface TranscriptFixedAppend {
  readonly contract: { readonly key: 'transcript.append'; readonly version: 1 };
  readonly operation: TranscriptAppendOperation;
  readonly transcriptId: string;
  readonly messages: readonly Readonly<Message>[];
}

/** The original committed location, independent of the current collection length. */
export interface TranscriptAppendReceipt {
  readonly transcriptId: string;
  readonly start: number;
  readonly count: number;
  readonly revision: number;
}

/** Fixed request and receipt share the same commit as the message mutation. */
export interface TranscriptAppendState {
  readonly request: TranscriptFixedAppend;
  readonly receipt: TranscriptAppendReceipt;
}
