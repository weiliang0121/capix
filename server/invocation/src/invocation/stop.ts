import { RuntimeError } from '@capix/contracts';

/** A structural or control error, never a declared business exception. */
export class InvocationStopped extends RuntimeError {}
