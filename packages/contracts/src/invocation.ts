import type { CallableKind } from './callable/kind.js';

/** Identity of one call, independent of reusable structures and observation carriers. */
export interface InvocationIdentity {
  readonly contextId: string;
  readonly kind: CallableKind;
  readonly parentContextId?: string;
}

/** Identity of the call that caused a fact; not the identity of a resource operation. */
export interface InvocationOrigin {
  readonly contextId: string;
}

/** Parent-owned child relation identity, shared by running and recorded facts. */
export interface InvocationRelationIdentity {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly parentRound: number;
  readonly key?: string;
}
