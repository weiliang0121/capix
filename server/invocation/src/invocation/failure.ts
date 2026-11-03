import type { InvocationFailureFact } from '@capix/contracts';
import type { InvocationExceptionOrigin } from './provenance.js';

/** Delivery classification is independent of whether work already established effects. */
export interface InvocationFailure extends InvocationFailureFact {
  readonly error: unknown;
  readonly origin?: InvocationExceptionOrigin;
  /** Live reception eligibility, independent of diagnostic kind: ordinary Error can be receivable.
   * A parent still checks the exact relation, phase and active window; history grants no authority. */
  readonly receptionAllowed?: boolean;
}
export type InvocationPhase = InvocationFailureFact['phase'];

export function failureFact(failure: InvocationFailure): InvocationFailureFact {
  return { kind: failure.kind, phase: failure.phase, contextId: failure.contextId, ...(failure.contract ? { contract: failure.contract } : {}) };
}

/** Error inspection must not execute user accessors or iterators during failure ownership. */
export function containsFailure(error: AggregateError, failure: unknown): boolean {
  try {
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    if (cause && 'value' in cause && cause.value === failure) return true;
    const errors = Object.getOwnPropertyDescriptor(error, 'errors');
    if (!errors || !('value' in errors) || !Array.isArray(errors.value)) return false;
    return Object.entries(Object.getOwnPropertyDescriptors(errors.value)).some(([key, descriptor]) => /^(0|[1-9]\d*)$/.test(key) && 'value' in descriptor && descriptor.value === failure);
  } catch {
    return false;
  }
}
