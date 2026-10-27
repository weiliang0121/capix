import type { InvocationRelationIdentity } from '@capix/protocol';
import type { BusinessEvent } from '@capix/contracts';
import type { InvocationIdentity } from '@capix/contracts';
import type { ContextState } from '../context/context.js';
import type { InvocationProcess } from '../invocation/work.js';
import type { InvocationResult } from '../invocation/result.js';
import type { InvocationFailure } from '../invocation/failure.js';

export type { InvocationRelationIdentity } from '@capix/protocol';
export type { InvocationIdentity } from '@capix/contracts';

export interface InvocationDescription {
  /** Host-only description; never grants execution, membership or recovery authority. */
  readonly role?: string;
  /** Stable bound-structure identity when supplied; not an invocation or record ID. */
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
}

export type InvocationRelationChange = { readonly kind: 'attached' } | { readonly kind: 'returned'; readonly result: InvocationResult<unknown> } | { readonly kind: 'receiving' } | { readonly kind: 'accepted' | 'handled'; readonly output: unknown } | { readonly kind: 'failed'; readonly error: unknown; readonly source: 'work' | 'observation'; readonly failure?: InvocationFailure };

export type InvocationChange = { readonly kind: 'started'; readonly input: unknown } | { readonly kind: 'process'; readonly process: InvocationProcess; readonly processSequence: number; readonly round: number } | { readonly kind: 'relation'; readonly relation: InvocationRelationIdentity; readonly change: InvocationRelationChange } | { readonly kind: 'finished'; readonly state: ContextState<unknown> };

/** Borrowed values are only valid during synchronous observation. This is not a wire DTO. */
export type InvocationFact = InvocationChange & {
  readonly identity: InvocationIdentity;
  readonly description?: InvocationDescription;
  readonly eventSequence: number;
  readonly occurredAt: string;
  readonly monotonicTime: number;
};

export type { ResourceObservation } from '@capix/resources';

export type { BusinessEvent } from '@capix/contracts';

export interface BusinessObservation {
  readonly identity: InvocationIdentity;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly event: Readonly<BusinessEvent>;
}
