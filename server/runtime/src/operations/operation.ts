import { randomUUID } from 'node:crypto';
import { InvocationBehavior } from '../invocation/behavior.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { OperationInvocationBuilder } from '../invocation/operation/builder.js';

/** A reusable work unit. Concrete operations organize their own named attempts. */
export abstract class Operation<I, O> extends InvocationBehavior<I, O, OperationContext<I, O>> {
  readonly id = randomUUID();
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;

  constructor(private readonly invocations: OperationInvocationBuilder) {
    super();
  }

  async call(execution: ExecutionContext, input: I, parent?: OperationContext): Promise<O> {
    return this.invocations.create<I, O>(execution, input, this, this.work, parent).run();
  }
}
