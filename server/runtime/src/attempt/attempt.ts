import type { Invocation } from '../invocation/invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { BoundChildren } from '../binding/children.js';
import { bindInvocationWork } from '../binding/work.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** A bound leaf node: fixed call mechanics and explicitly supplied content. */
export class Attempt<I, O, R extends object = object> {
  private readonly work;
  constructor(
    private readonly invocations: AttemptInvocationBuilder,
    readonly definition: AttemptDefinition<I, O, R>,
    children: BoundChildren,
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    return this.invocations.create<I, O, R>(parent, { input, requires: this.definition.requires, description: this.definition, work: this.work, key: options.key });
  }
  call(parent: Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
