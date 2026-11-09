import type { ModelReply, ToolFeedback } from '@weiliang0121/capix-model-provider';

/** A business grouping, not an authorization credential or an invocation owner. */
export type ExchangeScope = string;

export interface ExchangeReference {
  readonly collection: string;
  readonly id: string;
  readonly revision: number;
}

/** Trusted host provenance; the resource adapter obtains these IDs from reception. */
export interface ExchangeOperation {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly position: string;
}

export interface ExchangeIntakeReceipt {
  readonly reference: ExchangeReference;
  readonly operation: ExchangeOperation;
}

export interface ExchangeFeedbackReceipt extends ExchangeIntakeReceipt {
  readonly feedbackDigest: string;
}

/** One model reply and its fixed feedback slots; never a second execution state. */
export interface ModelExchangeEntry {
  readonly id: string;
  readonly scope: ExchangeScope;
  readonly revision: number;
  readonly sequence: number;
  readonly operation: ExchangeOperation;
  readonly reply: ModelReply;
  readonly feedback: readonly ToolFeedback[];
  readonly receptions: readonly { readonly callId: string; readonly operation: ExchangeOperation }[];
}

export interface ModelExchangesState {
  readonly formatVersion: 1;
  readonly id: string;
  readonly sequence: number;
  readonly entries: readonly ModelExchangeEntry[];
}

/** Commit only the changed exchange; the host atomically compares sequence first. */
export interface ModelExchangesCommit {
  readonly collection: string;
  readonly expectedSequence: number;
  readonly sequence: number;
  readonly previous: ModelExchangeEntry | null;
  readonly entry: ModelExchangeEntry;
}

export interface ModelExchangesPersistence {
  commit(change: ModelExchangesCommit): undefined;
}

/** Metadata only: the entity holds the reply, observers do not get a second copy. */
export interface ModelExchangeChange {
  readonly type: 'model-exchange';
  readonly collection: string;
  readonly sequence: number;
  readonly reference: ExchangeReference;
  readonly scope: ExchangeScope;
  readonly kind: 'intake' | 'feedback';
  readonly toolCallId?: string;
}
