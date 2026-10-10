import type { InvocationFailure } from './failure.js';
export type InvocationResult<Output> = Readonly<{ status: 'succeeded'; output: Output } | { status: 'failed'; error: unknown; failure?: InvocationFailure }>;

/** Explicit local continuation; no identity, lifecycle or execution of its own. */
export class Continuation<Input> {
  constructor(
    readonly input: Input,
    readonly reason: string,
  ) {
    Object.freeze(this);
  }
}

export function receiveResult<Output>(result: InvocationResult<Output>): Output {
  if (result.status === 'failed') throw result.error;
  return result.output;
}

/** Explicit handler result; it cannot mutate invocation state or manufacture a child result. */
export type InvocationResolution<Input, Output> = Readonly<{ kind: 'return'; output: Output } | { kind: 'continue'; input: Input; reason: string } | { kind: 'unhandled' }>;
