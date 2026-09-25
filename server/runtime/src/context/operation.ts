import type { ExecutionContext } from './execution.js';
import { RuntimeContext } from './context.js';

/** One operation invocation; descriptive information is captured directly by its record. */
export class OperationContext<I = unknown, O = unknown> extends RuntimeContext<I, O> {
  constructor(
    readonly executionContext: ExecutionContext,
    input: I,
  ) {
    super(input);
    Object.freeze(this);
  }
}
