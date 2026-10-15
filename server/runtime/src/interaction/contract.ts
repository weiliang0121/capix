import type { RuntimeErrorValue } from '@capix/protocol';
import type { ProgressReceiver } from '../progress.js';

/** A versioned data boundary, independent of any invocation or recording preset. */
export interface InteractionContract<Request, Reply> {
  readonly key: string;
  request(value: unknown): Request;
  reply(value: unknown): Reply;
}

export interface InteractionFeedback<Reply> {
  readonly id: string;
  readonly payload: Readonly<Reply>;
}

/** `started` records dispatch intent, not proof that the external system executed it. */
export interface InteractionState<Request = unknown, Reply = unknown> {
  readonly id: string;
  readonly contract: string;
  readonly revision: number;
  readonly request: Readonly<Request>;
  readonly delivery: 'prepared' | 'started';
  readonly feedback?: InteractionFeedback<Reply>;
  /** Local delivery/capture failure. It does not assert absence of external effects. */
  readonly failure?: RuntimeErrorValue;
}

export interface InteractionCommit<Request = unknown, Reply = unknown> {
  readonly expectedRevision: number;
  readonly state: InteractionState<Request, Reply>;
}

/** Commit synchronously before exposing the next state; implementations must reject stale revisions. */
export interface InteractionPersistence<Request = unknown, Reply = unknown> {
  create(state: InteractionState<Request, Reply>): undefined;
  commit(change: InteractionCommit<Request, Reply>): undefined;
}

export interface InteractionOptions<Request, Reply> {
  readonly contract: InteractionContract<Request, Reply>;
  readonly persistence?: InteractionPersistence<Request, Reply>;
  /** Passive facts after state installation. A failed observer never rejects delivery or feedback. */
  readonly observation?: ProgressReceiver<InteractionFact<Request, Reply>>;
}

export type InteractionFact<Request = unknown, Reply = unknown> = { readonly type: 'changed'; readonly state: InteractionState<Request, Reply> } | { readonly type: 'unavailable'; readonly state: InteractionState<Request, Reply>; readonly error: RuntimeErrorValue };

export type InteractionRead<Reply> = { readonly kind: 'pending' } | { readonly kind: 'received'; readonly feedback: InteractionFeedback<Reply> } | { readonly kind: 'unavailable'; readonly error: unknown };

export type InteractionWait<Reply> = Exclude<InteractionRead<Reply>, { readonly kind: 'pending' }> | { readonly kind: 'wait-expired' };

export interface InteractionWaitOptions {
  readonly waitMs: number;
  readonly signal?: AbortSignal;
}
