import type { InvocationLevel } from '@capix/protocol';

/** Identity of one call, independent of reusable structures and observation carriers. */
export interface InvocationIdentity {
  readonly contextId: string;
  readonly level: InvocationLevel;
  readonly parentContextId?: string;
}
