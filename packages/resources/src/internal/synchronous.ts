import { ResourcePortError } from '../errors.js';

/** Reject async host ports without leaving a later rejection outside the owning call. */
export function synchronous<Value>(value: Value, label: string): Value {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new ResourcePortError(`${label} must complete synchronously`);
  }
  return value;
}
