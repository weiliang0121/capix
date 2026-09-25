import { RuntimeError } from '../errors/error.js';
import { RecordingError } from '../records/error.js';

/** A control stop is not offered to a receiver as a recoverable work failure. */
export class InvocationStopped extends RuntimeError {}

export function mustStop(error: unknown, visited = new Set<AggregateError>()): boolean {
  if (error instanceof InvocationStopped || error instanceof RecordingError) return true;
  if (!(error instanceof AggregateError) || visited.has(error)) return false;
  visited.add(error);
  return error.errors.some((member) => mustStop(member, visited));
}
