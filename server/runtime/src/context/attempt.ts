import type { OperationContext } from './operation.js';
import { InvocationContext } from './context.js';

/** One named action invocation, independent of its source and observation description. */
export class AttemptContext<I = unknown, O = unknown> extends InvocationContext<I, O> {
  readonly signal: AbortSignal;

  constructor(
    readonly operationContext: OperationContext,
    input: I,
  ) {
    super(input);
    this.signal = operationContext.signal;
    Object.freeze(this);
  }
}
