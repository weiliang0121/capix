import { RuntimeError } from '../errors/error.js';

/** A structural or control error, never a declared business exception. */
export class InvocationStopped extends RuntimeError {}
