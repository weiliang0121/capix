import { InvocationStopped } from '../invocation/stop.js';
import { ObservationError } from '../observation/error.js';
import { ChangeCaptureError } from '@weiliang0121/capix-changes';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ResourceAccessClosed, ResourcePortError } from '@weiliang0121/capix-resources';
import { StableValueError } from '@weiliang0121/capix-contracts';

/** Failure reception is for operation outcomes, never for control or required fact delivery. */
export function isProtectedOperationFailure(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || (typeof current !== 'object' && typeof current !== 'function') || visited.has(current)) continue;
    visited.add(current);
    try {
      if (current instanceof StableValueError || current instanceof InvocationStopped || current instanceof ObservationError || current instanceof ChangeCaptureError || current instanceof PersistenceError || current instanceof ResourceAccessClosed || current instanceof ResourcePortError) return true;
      if (!(current instanceof AggregateError)) continue;
      // Error values are untrusted. Never execute an errors getter or array iterator
      // while deciding whether a business receiver may consume the original failure.
      const errors = Object.getOwnPropertyDescriptor(current, 'errors');
      if (!errors || !('value' in errors) || !Array.isArray(errors.value)) return true;
      for (const [key, item] of Object.entries(Object.getOwnPropertyDescriptors(errors.value))) {
        if (!/^(0|[1-9]\d*)$/.test(key)) continue;
        if (!('value' in item)) return true;
        pending.push(item.value);
      }
    } catch {
      // An opaque/proxied error cannot prove eligibility; preserve it as a strict failure.
      return true;
    }
  }
  return false;
}
