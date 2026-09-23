import { RuntimeContext } from './context.js';

export type AttemptPhase = 'before' | 'commit' | 'after';

/** One phase invocation, independent of its source and observation description. */
export class AttemptContext<I = unknown, O = unknown> extends RuntimeContext<I, O> {
  constructor(
    readonly operationId: string,
    readonly phase: AttemptPhase,
    input: I,
  ) {
    super(input);
    Object.freeze(this);
  }
}
