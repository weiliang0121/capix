import { RuntimeError } from '@capix/contracts';

/** A rejected caller transition is known not to have written anything. */
export class RecoveryConflict extends RuntimeError {
  constructor(code: 'CHECKPOINT_CONFLICT' | 'INTERACTION_PERSISTENCE_CONFLICT', message: string) {
    super(code, message);
  }
}

export type RecoveryTransaction = <T>(operation: string, work: () => T) => T;

export function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new TypeError('Expected revision must be a nonnegative safe integer with room to advance');
}

export function requireIdentity(identity: string): void {
  if (typeof identity !== 'string' || !identity.trim()) throw new TypeError('Persistence identity must be nonempty');
}
