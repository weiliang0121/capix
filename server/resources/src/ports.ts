import type { TranscriptEvent, MemoryEvent } from '@weiliang0121/capix-protocol';
import type { ResourceEventConsumer, ResourceObservation } from './facts.js';
import { synchronous } from './internal/synchronous.js';

/** A host classifies its own failures without exporting runtime error types. */
export interface ResourceFailurePolicy {
  isProtected(error: unknown): boolean;
  isCancellation(error: unknown, signal: AbortSignal): boolean;
  describe(error: unknown): unknown;
}

/** Fixed ports belonging to one access owner, never exposed through business endpoints. */
export interface ResourceOwner {
  readonly contextId: string;
  readonly failures: ResourceFailurePolicy;
  readonly signal?: AbortSignal;
  readonly reception?: () => Readonly<{ parentContextId: string; childContextId: string }>;
  readonly nextSequence?: () => number;
  readonly observation?: ResourceEventConsumer<ResourceObservation>;
  readonly transcript?: ResourceEventConsumer<TranscriptEvent>;
  readonly memory?: ResourceEventConsumer<MemoryEvent>;
  readonly validate: () => void;
  readonly error?: (error: unknown, allowException?: boolean) => void;
}

export interface ResourceWindow {
  readonly signal?: AbortSignal;
  assertOpen(): void;
}

export { ResourceAccessClosed, ResourcePortError } from './errors.js';

export function captureResourceOwner(owner?: ResourceOwner): ResourceOwner | undefined {
  if (!owner) return undefined;
  const policy = owner.failures;
  if (!policy || typeof policy.isProtected !== 'function' || typeof policy.isCancellation !== 'function' || typeof policy.describe !== 'function') throw new TypeError('Resource owner requires a complete failure policy');
  if (typeof owner.validate !== 'function') throw new TypeError('Resource owner requires an access validator');
  const describe = policy.describe.bind(policy);
  const validate = owner.validate.bind(owner);
  const error = owner.error?.bind(owner);
  const reception = owner.reception?.bind(owner);
  const nextSequence = owner.nextSequence?.bind(owner);
  return Object.freeze({
    contextId: owner.contextId,
    signal: owner.signal,
    failures: Object.freeze({ isProtected: policy.isProtected.bind(policy), isCancellation: policy.isCancellation.bind(policy), describe: (failure: unknown) => synchronous(describe(failure), 'Resource failure description') }),
    validate: () => {
      synchronous(validate(), 'Resource owner validation');
    },
    error: error
      ? (failure: unknown, allowException?: boolean) => {
          synchronous(error(failure, allowException), 'Resource failure reporting');
        }
      : undefined,
    reception: reception ? () => synchronous(reception(), 'Resource reception provenance') : undefined,
    nextSequence: nextSequence ? () => synchronous(nextSequence(), 'Resource observation sequence') : undefined,
    observation: captureConsumer(owner.observation),
    transcript: captureConsumer(owner.transcript),
    memory: captureConsumer(owner.memory),
  });
}

function captureConsumer<Event>(consumer?: ResourceEventConsumer<Event>): ResourceEventConsumer<Event> | undefined {
  if (!consumer) return undefined;
  const publish = consumer.publish.bind(consumer);
  return Object.freeze({ publish: (event: Event) => synchronous(publish(event), 'Resource event publication') });
}
