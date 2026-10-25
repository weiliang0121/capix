import { RuntimeError } from './error.js';

/** A required persistence port failed; an operation fallback cannot replace its missing fact. */
export class PersistenceError extends RuntimeError {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super('PERSISTENCE_FAILED', `Required persistence failed: ${operation}`, undefined, { cause });
  }
}
