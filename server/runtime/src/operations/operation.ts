import { randomUUID } from 'node:crypto';
import type { Invocation } from '../invocation/invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { BoundChildren } from '../binding/children.js';
import { bindInvocationWork } from '../binding/work.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** A reusable bound O node; individual calls remain separate Invocation objects. */
export class Operation<I, O, R extends object = object> {
  readonly id = randomUUID();
  private readonly work;
  constructor(
    private readonly invocations: OperationInvocationBuilder,
    readonly definition: OperationDefinition<I, O, R>,
    readonly children: BoundChildren,
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    const { name, label, source, requires } = this.definition;
    return this.invocations.create<I, O, R>(parent, { input, requires, description: { id: this.id, name, label, source }, work: this.work, key: options.key });
  }
  call(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
