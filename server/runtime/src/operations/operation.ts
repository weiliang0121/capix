import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { Invocation } from '../invocation/invocation.js';
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

  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    return this.invocations.create<I, O>(parent, { input, description: this, work: this.work, key: options.key });
  }

  async call(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
