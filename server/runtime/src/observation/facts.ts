import type { InvocationRelationIdentity } from '@capix/protocol';
import type { InvocationIdentity } from '../invocation/identity.js';
import type { ContextState } from '../context/context.js';
import type { InvocationProcess } from '../invocation/cycle.js';
import type { InvocationResult } from '../invocation/result.js';
import type { InvocationFailure } from '../invocation/failure.js';

export type { InvocationRelationIdentity } from '@capix/protocol';
export type { InvocationIdentity } from '../invocation/identity.js';

export interface InvocationDescription {
  /** Stable bound-structure identity when supplied; not an invocation or record ID. */
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
}

export type InvocationRelationChange = { readonly kind: 'attached' } | { readonly kind: 'returned'; readonly result: InvocationResult<unknown> } | { readonly kind: 'receiving' } | { readonly kind: 'accepted'; readonly output: unknown } | { readonly kind: 'failed'; readonly error: unknown; readonly source: 'work' | 'observation'; readonly failure?: InvocationFailure };

/** Entry progress belongs to the parent call before a child Context exists. */
export type ExecutionEntryChange = Readonly<
  {
    target: 'execution';
    instanceId: string;
    key?: string;
    stage: 'accept' | 'notification' | 'admit' | 'capture';
  } & ({ status: 'accepted' } | { status: 'failed'; error: unknown })
>;

export type InvocationChange = { readonly kind: 'started'; readonly input: unknown } | { readonly kind: 'process'; readonly process: InvocationProcess; readonly processSequence: number; readonly round: number } | ({ readonly kind: 'entry' } & ExecutionEntryChange) | { readonly kind: 'relation'; readonly relation: InvocationRelationIdentity; readonly change: InvocationRelationChange } | { readonly kind: 'finished'; readonly state: ContextState<unknown> };

/** Borrowed values are only valid during synchronous observation. This is not a wire DTO. */
export type InvocationFact = InvocationChange & {
  readonly identity: InvocationIdentity;
  readonly description?: InvocationDescription;
  readonly eventSequence: number;
  readonly occurredAt: string;
  readonly monotonicTime: number;
};

export interface ResourceObservation {
  readonly contextId: string;
  readonly access: string;
  readonly supplyId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
  /** Resource-owned synchronous projection, only evaluated by an interested observer. */
  readonly describe: () => unknown;
}

/** Facts of the reusable structure, ordered independently from individual calls. */
export type RuntimeStructureFact = Readonly<
  {
    runtimeId: string;
    sequence: number;
    occurredAt: string;
  } & ({ kind: 'established' } | { kind: 'acquired' } | { kind: 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown })
>;
