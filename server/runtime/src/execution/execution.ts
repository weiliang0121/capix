import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import { InvocationBehavior } from '../invocation/behavior.js';
import type { ExecutionContext, ExecutionOptions, ExecutionResourceSource } from '../context/execution.js';
import type { ExecutionInvocationBuilder, ExecutionStarted } from '../invocation/execution/builder.js';

/** Reusable work behavior; construction and reservation belong to its injected builder. */
export abstract class Execution<I, O, R extends object = object> extends InvocationBehavior<I, O, ExecutionContext<I, O, R>> {
  readonly requires: ResourceRequirements<R> = Object.freeze({}) as ResourceRequirements<R>;
  protected resourceBinding?: (source: ExecutionResourceSource) => ResourceBindings<R>;

  constructor(private readonly invocations: ExecutionInvocationBuilder) {
    super();
  }

  call(input: I, options: ExecutionOptions, started?: ExecutionStarted<I, O, R>): Promise<O> {
    return this.submit(() => input, options, started);
  }

  submit(accept: () => I, options: ExecutionOptions, started?: ExecutionStarted<I, O, R>): Promise<O> {
    return this.invocations.submit(accept, { context: options, resourceBinding: this.resourceBinding, requires: this.requires, work: this.work, started });
  }
}
