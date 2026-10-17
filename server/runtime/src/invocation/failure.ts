import type { InvocationFailureFact } from '@capix/protocol';
import type { InvocationExceptionOrigin } from './provenance.js';

/** Delivery classification is independent of whether work already established effects. */
export interface InvocationFailure extends InvocationFailureFact {
  readonly error: unknown;
  readonly origin?: InvocationExceptionOrigin;
}
export type InvocationPhase = InvocationFailureFact['phase'];

export function failureFact(failure: InvocationFailure): InvocationFailureFact {
  return { kind: failure.kind, phase: failure.phase, contextId: failure.contextId, ...(failure.contract ? { contract: failure.contract } : {}) };
}
