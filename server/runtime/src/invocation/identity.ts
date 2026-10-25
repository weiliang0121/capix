import type { CallableKind } from '@capix/contracts';

/** Identity of one call, independent of reusable structures and observation carriers. */
export interface InvocationIdentity {
  readonly contextId: string;
  readonly kind: CallableKind;
  readonly parentContextId?: string;
}
