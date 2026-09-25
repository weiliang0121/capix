export type InvocationResult<O> = Readonly<{ status: 'succeeded'; output: O } | { status: 'failed'; error: unknown }>;

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
