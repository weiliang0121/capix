/** A synchronous resource consumer reports a required delivery failure as its return value. */
export interface ResourceEventConsumer<Event> {
  publish(event: Event): unknown | undefined;
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
