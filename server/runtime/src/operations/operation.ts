import type { ResourceRequirements } from '../resource/bindings.js';
import { definitionResources } from '../definition/invocation.js';
import { randomUUID } from 'node:crypto';
import type { Invocation } from '../invocation/invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { BoundChildren } from '../binding/children.js';
import { bindInvocationWork } from '../binding/work.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** A reusable bound O node; individual calls remain separate Invocation objects. */
export class Operation<I, O, R extends object = object> {
  readonly id = randomUUID();
  private readonly work: InvocationWork<OperationContext<I, O, R>, I, O>;
  constructor(
    private readonly invocations: OperationInvocationBuilder,
    readonly definition: OperationDefinition<I, O, R, any>,
    readonly children: BoundChildren,
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    const { name, label, source } = this.definition;
    const requires = definitionResources(this.definition) as ResourceRequirements<R>;
    return this.invocations.create<I, O, R>(parent, { input, requires, initial: this.definition.run.requires, observation: this.definition.observation, description: { id: this.id, name, label, source }, work: this.work, key: options.key });
  }
  call(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
