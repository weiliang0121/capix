import { RuntimeError } from '@weiliang0121/capix-contracts';

/** A structural or control error, never a declared business exception. */
export class InvocationStopped extends RuntimeError {}
