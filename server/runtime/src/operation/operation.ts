import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRefinement } from '../resource/offer.js';
import { definitionResources } from '../binding/resources.js';
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
export class BoundOperation<Input, Output, Resources extends object = object> {
  readonly id = randomUUID();
  private readonly work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>;
  constructor(
    private readonly invocationBuilder: OperationInvocationBuilder,
    readonly definition: OperationDefinition<Input, Output, Resources, any, any>,
    readonly children: BoundChildren,
    private readonly requires: ResourceRequirements<Resources> = definitionResources(definition) as ResourceRequirements<Resources>,
    private readonly refinements?: readonly ResourceRefinement<Input>[],
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: Input, options: InvocationRelationOptions = {}) {
    const { name, label, source } = this.definition;
    return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.requires, initial: this.definition.run.requires, refinements: this.refinements, observation: this.definition.observation, description: { id: this.id, name, label, source }, work: this.work, key: options.key, output: options.output });
  }
  call(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: Input): Promise<Output> {
    return this.create(parent, input).run();
  }
}
