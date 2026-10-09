import type { ContextState } from '../context/context.js';
import type { InvocationProcess } from '../invocation/cycle.js';
import type { InvocationResult } from '../invocation/result.js';
import type { InvocationFailure } from '../invocation/failure.js';

export interface CallIdentity {
  readonly contextId: string;
  readonly level: 'runtime' | 'execution' | 'operation' | 'attempt';
  readonly parentContextId?: string;
}

export interface CallDescription {
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
}

export interface RelationIdentity {
  readonly parentContextId: string;
  readonly childContextId: string;
  readonly parentRound: number;
  readonly key?: string;
}

export type RelationChange = { readonly kind: 'attached' } | { readonly kind: 'returned'; readonly result: InvocationResult<unknown> } | { readonly kind: 'receiving' } | { readonly kind: 'accepted'; readonly output: unknown } | { readonly kind: 'failed'; readonly error: unknown; readonly source: 'work' | 'observation'; readonly failure?: InvocationFailure };

/** Entry progress belongs to the parent call before a child Context exists. */
export type EntryChange = Readonly<
  {
    target: 'execution';
    instanceId: string;
    key?: string;
    stage: 'accept' | 'notification' | 'admit' | 'capture';
  } & ({ status: 'accepted' } | { status: 'failed'; error: unknown })
>;

export type CallChange = { readonly kind: 'started'; readonly input: unknown } | { readonly kind: 'process'; readonly process: InvocationProcess; readonly processSequence: number; readonly round: number } | ({ readonly kind: 'entry' } & EntryChange) | { readonly kind: 'relation'; readonly relation: RelationIdentity; readonly change: RelationChange } | { readonly kind: 'finished'; readonly state: ContextState<unknown> };

/** Borrowed values are only valid during synchronous observation. This is not a wire DTO. */
export type CallFact = CallChange & {
  readonly identity: CallIdentity;
  readonly description?: CallDescription;
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
export type RuntimeFact = Readonly<
  {
    runtimeId: string;
    sequence: number;
    occurredAt: string;
  } & ({ kind: 'established' } | { kind: 'acquired' } | { kind: 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown })
>;
