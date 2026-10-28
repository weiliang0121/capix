/** A position in one exchange's immutable process feedback, not business acceptance. */
export interface InteractionCursor {
  readonly interactionId: string;
  readonly sequence: number;
}

export interface InteractionProgressLimits {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxReaders?: number;
}

export interface InteractionProgressBudgetLimits {
  readonly maxBytes?: number;
  readonly maxReaders?: number;
}

/** Installed lifecycle metadata. Neither preview payload nor invocation state is included. */
export interface InteractionProgressFact {
  readonly interactionId: string;
  readonly phase: 'created' | 'sealed' | 'unavailable' | 'reader-opened' | 'reader-closed';
  readonly lastSequence: number;
  readonly entries: number;
  readonly bytes: number;
  readonly readers: number;
  readonly reason?: string;
}

export type InteractionProgressRead<Delta> = { readonly kind: 'item'; readonly cursor: InteractionCursor; readonly value: Readonly<Delta> } | { readonly kind: 'sealed'; readonly lastSequence: number } | { readonly kind: 'unavailable'; readonly reason: string } | { readonly kind: 'wait-expired' };

export interface InteractionProgressReader<Delta> {
  readonly position: InteractionCursor;
  next(options: { readonly waitMs: number; readonly signal?: AbortSignal }): Promise<InteractionProgressRead<Delta>>;
  close(reason?: unknown): void;
}

export type InteractionPublication = { readonly kind: 'published'; readonly cursor: InteractionCursor } | { readonly kind: 'unavailable'; readonly reason: string } | { readonly kind: 'sealed' };

export interface InteractionPublisher<Delta> {
  publish(value: Delta): InteractionPublication;
}
