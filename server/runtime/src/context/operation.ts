import type { ExecutionContext } from './execution.js';
import { InvocationContext } from './context.js';

/** One operation invocation; descriptive information is captured directly by its record. */
export class OperationContext<I = unknown, O = unknown> extends InvocationContext<I, O> {
  readonly signal: AbortSignal;

  constructor(
    readonly executionContext: ExecutionContext,
    input: I,
  ) {
    super(input);
    this.signal = executionContext.signal;
    Object.freeze(this);
  }
}
