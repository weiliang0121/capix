import type { RuntimeErrorValue } from '../invocation/errors.js';

/** Links granted by the selected call's recorded resource accesses, not arbitrary entity lookup. */
export interface CallInteractionLinks {
  readonly callId: string;
  readonly interactionIds: readonly string[];
}

/** A public metadata projection. Request/reply bodies remain outside this observation endpoint. */
export interface InteractionObservation {
  readonly id: string;
  readonly contract: string;
  /** Revision of committed interaction facts, independent of a call's local sequence. */
  readonly revision: number;
  readonly delivery: 'prepared' | 'started';
  readonly retained: 'persistent' | 'memory';
  readonly model: string;
  readonly purpose: string;
  readonly result: { readonly kind: 'pending' } | { readonly kind: 'received'; readonly feedbackId: string } | { readonly kind: 'unavailable'; readonly error: RuntimeErrorValue };
}

export type InteractionUpdate = { readonly type: 'snapshot'; readonly value: InteractionObservation } | { readonly type: 'error'; readonly error: string; readonly code?: string };
