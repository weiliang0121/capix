import { InvocationBehavior } from '../invocation/behavior.js';
import type { ExecutionContext, ExecutionOptions } from '../context/execution.js';
import type { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';

/** Reusable work behavior; construction and reservation belong to its injected builder. */
export abstract class Execution<I, O> extends InvocationBehavior<I, O, ExecutionContext<I, O>> {
  constructor(private readonly invocations: ExecutionInvocationBuilder) {
    super();
  }

  call(input: I, options: ExecutionOptions, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return this.submit(() => input, options, started);
  }

  submit(accept: () => I, options: ExecutionOptions, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return this.invocations.submit(accept, options, this.work, started);
  }
}
