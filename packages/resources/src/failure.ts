import { ResourceAccessClosed, ResourcePortError } from './errors.js';

/** Resource-owned control failures stay protected even when a caller preserves them in an aggregate. */
export function isResourceAccessFailure(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || (typeof current !== 'object' && typeof current !== 'function') || visited.has(current)) continue;
    visited.add(current);
    try {
      if (current instanceof ResourceAccessClosed || current instanceof ResourcePortError) return true;
      if (!(current instanceof AggregateError)) continue;
      // Do not invoke a failure's errors getter or an array's custom iterator.
      const errors = Object.getOwnPropertyDescriptor(current, 'errors');
      if (!errors || !('value' in errors) || !Array.isArray(errors.value)) return true;
      for (const [key, item] of Object.entries(Object.getOwnPropertyDescriptors(errors.value))) {
        if (!/^(0|[1-9]\d*)$/.test(key)) continue;
        if (!('value' in item)) return true;
        pending.push(item.value);
      }
    } catch {
      // An opaque error cannot prove that business failure reception is safe.
      return true;
    }
  }
  return false;
}
