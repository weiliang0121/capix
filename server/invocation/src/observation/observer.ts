import { InvocationResources } from '../invocation/resource-access.js';
import type { TranscriptEvent, MemoryEvent } from '@weiliang0121/capix-protocol';

import type { InvocationFact, ResourceObservation, BusinessObservation } from './facts.js';

export type { EventConsumer } from '@weiliang0121/capix-changes';

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
