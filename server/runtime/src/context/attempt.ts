import type { OperationContext } from './operation.js';
import { InvocationContext } from './context.js';

/** One named action invocation, independent of its source and observation description. */
export class AttemptContext<I = unknown, O = unknown> extends InvocationContext<I, O> {
  constructor(
    readonly operationContext: OperationContext,
    input: I,
  ) {
    super(input);
    Object.freeze(this);
  }
}
