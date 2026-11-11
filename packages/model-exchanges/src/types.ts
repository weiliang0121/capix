import type { ModelReply, ModelRequest, ModelTool, ToolFeedback } from '@weiliang0121/capix-model-provider';

/** Fixed protocol data. The catalog carries no Node, callback or resource authority. */
export interface ModelExchangeBasis {
  readonly request: Omit<ModelRequest, 'tools' | 'exchanges'>;
  readonly catalog: {
    readonly tools: readonly ModelTool[];
    /** Compatibility identifier supplied by the structure that will execute tools. */
    readonly digest: string;
    readonly policyVersion: string;
  };
}

/** One content origin within a collection; independent of invocation lifetime. */
export interface ModelExchangeOrigin extends ModelExchangeBasis {
  readonly id: string;
  readonly sequence: number;
  /** Digest of the full fixed basis, not just the model-visible tool schemas. */
  readonly digest: string;
}

export interface ExchangeOriginReference {
  readonly collection: string;
  readonly id: string;
  readonly digest: string;
}

/** An explicit historical prefix. It does not authorize sending or retrying. */
export interface ExchangePrefix {
  readonly origin: ExchangeOriginReference;
  readonly exchanges: readonly ExchangeReference[];
}

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
  readonly origin: string;
  readonly revision: number;
  readonly sequence: number;
  readonly operation: ExchangeOperation;
  readonly reply: ModelReply;
  readonly feedback: readonly ToolFeedback[];
  readonly receptions: readonly { readonly callId: string; readonly operation: ExchangeOperation }[];
}

export interface ModelExchangesState {
  readonly formatVersion: 2;
  readonly id: string;
  readonly sequence: number;
  readonly origins: readonly ModelExchangeOrigin[];
  readonly entries: readonly ModelExchangeEntry[];
}

interface ModelExchangesCommitBasis {
  readonly collection: string;
  readonly expectedSequence: number;
  readonly sequence: number;
}

/** One origin or exchange change; the host atomically compares sequence first. */
export type ModelExchangesCommit = ModelExchangesCommitBasis & ({ readonly kind: 'origin'; readonly origin: ModelExchangeOrigin } | { readonly kind: 'exchange'; readonly previous: ModelExchangeEntry | null; readonly entry: ModelExchangeEntry });

export interface ModelExchangesPersistence {
  commit(change: ModelExchangesCommit): undefined;
}

/** Metadata only: the entity holds the reply, observers do not get a second copy. */
interface ModelExchangeChangeBasis {
  readonly type: 'model-exchange';
  readonly collection: string;
  readonly sequence: number;
  readonly origin: string;
}

export type ModelExchangeChange = ModelExchangeChangeBasis & ({ readonly kind: 'origin'; readonly reference: ExchangeOriginReference } | { readonly kind: 'intake' | 'feedback'; readonly reference: ExchangeReference; readonly toolCallId?: string });
