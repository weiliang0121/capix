import { stableValue, type Stable, type InvocationFailureFact, type RuntimeErrorValue } from '@capix/contracts';
import { RuntimeErrorHelper } from '@capix/diagnostics';
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

/** Capture inert diagnostic content once; the original thrown value keeps its live identity. */
export function failureDiagnostic(error: unknown): Stable<RuntimeErrorValue> {
  try {
    return stableValue<RuntimeErrorValue>(RuntimeErrorHelper.format(error));
  } catch {
    // Diagnostic inspection must never replace the failure or interrupt required closing.
    const fallback: RuntimeErrorValue = { code: 'UNREADABLE_ERROR', message: '[Uninspectable thrown value]' };
    return stableValue<RuntimeErrorValue>(fallback);
  }
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
