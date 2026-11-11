import { InvocationResources } from '../invocation/resource-access.js';
import type { ResourceFact } from '@weiliang0121/capix-resources';

import type { InvocationFact, ResourceObservation, BusinessObservation } from './facts.js';

export type { EventConsumer } from '@weiliang0121/capix-changes';

/** A concrete installed capability may handle several typed sources without defining a carrier base. */
export interface InvocationObserver {
  readonly resources?: InvocationResources;
  observe(fact: InvocationFact): void;
  business?(fact: BusinessObservation): void;
  resource?(fact: ResourceObservation): void;
  fact?(fact: ResourceFact): void;
  available?(): boolean;
}
