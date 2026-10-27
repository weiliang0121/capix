import { RuntimeError } from '@capix/contracts';
import { isNonBlankString } from '../value/string.js';

/** Identity owned by the declaration producing an expected exceptional outcome. */
export class ExceptionContract<F = unknown> {
  constructor(readonly name: string) {
    if (!isNonBlankString(name)) throw new Error('Exception contract needs a name');
    Object.freeze(this);
  }
  create(message: string, facts: F, options?: ErrorOptions): DeclaredException<F> {
    return new DeclaredException(this, message, facts, options);
  }
}

/** Runtime facts, not a record snapshot. Contract identity, not a string code, controls handling. */
export class DeclaredException<F = unknown> extends RuntimeError {
  constructor(
    readonly contract: ExceptionContract<F>,
    message: string,
    readonly facts: F,
    options?: ErrorOptions,
  ) {
    super(contract.name, message, facts, options);
  }
}
