import type { InvocationFailure } from './failure.js';
export type InvocationResult<O> = Readonly<{ status: 'succeeded'; output: O } | { status: 'failed'; error: unknown; failure?: InvocationFailure }>;

/** Explicit local continuation; no identity, lifecycle or execution of its own. */
export class Continuation<I> {
  constructor(
    readonly input: I,
    readonly reason: string,
  ) {
    Object.freeze(this);
  }
}

export function receiveResult<O>(result: InvocationResult<O>): O {
  if (result.status === 'failed') throw result.error;
  return result.output;
}

/** Explicit handler result; it cannot mutate invocation state or manufacture a child result. */
export type InvocationResolution<I, O> = Readonly<{ kind: 'return'; output: O } | { kind: 'continue'; input: I; reason: string } | { kind: 'unhandled' }>;
