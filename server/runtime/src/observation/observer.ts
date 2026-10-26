import { InvocationResources } from '../invocation/resource-access.js';
import type { TranscriptEvent, MemoryEvent } from '@capix/protocol';

import type { InvocationFact, ResourceObservation, DriverFact, BusinessObservation } from './facts.js';

export type { EventConsumer } from '@capix/changes';

/** A concrete installed capability may handle several typed sources without defining a carrier base. */
export interface InvocationObserver {
  readonly resources?: InvocationResources;
  observe(fact: InvocationFact): void;
  business?(fact: BusinessObservation): void;
  resource?(fact: ResourceObservation): void;
  transcript?(event: TranscriptEvent): void;
  memory?(event: MemoryEvent): void;
  available?(): boolean;
}

export interface DriverObserver {
  observe(fact: DriverFact): undefined;
  available?(): boolean;
}
