import type { Fact } from '@weiliang0121/capix-changes';

/** A synchronous resource consumer reports a required delivery failure as its return value. */
export interface ResourceEventConsumer<Event> {
  readonly publish: (event: Event) => unknown | undefined;
}

/** Resource-owned facts, independent of the host's invocation or recording implementation. */
export interface ResourceObservation {
  readonly contextId: string;
  readonly offerId: string;
  readonly access: string;
  readonly supplyId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
  /** Evaluated only by an interested synchronous observer. */
  readonly describe: () => unknown;
}

/** A producer's fixed domain fact forwarded by one precise operation. This association
 * proves delivery through that operation, not that the operation caused the domain effect. */
export interface ResourceFact {
  readonly contextId: string;
  readonly offerId: string;
  readonly access: string;
  readonly supplyId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly fact: Fact;
}
