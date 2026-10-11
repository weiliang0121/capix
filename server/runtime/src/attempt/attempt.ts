import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRefinement } from '../resource/offer.js';
import { definitionResources } from '../binding/resources.js';
import type { Invocation } from '../invocation/invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { BoundChildren } from '../binding/children.js';
import { bindInvocationWork } from '../binding/work.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** Reusable bound A leaf; every call creates its own AttemptContext and Invocation. */
export class BoundAttempt<Input, Output, Resources extends object = object> {
  private readonly work: InvocationWork<Input, Output, AttemptContext<Input, Output, Resources>>;
  constructor(
    private readonly invocationBuilder: AttemptInvocationBuilder,
    readonly definition: AttemptDefinition<Input, Output, Resources, any>,
    children: BoundChildren,
    private readonly requires: ResourceRequirements<Resources> = definitionResources(definition) as ResourceRequirements<Resources>,
    private readonly refinements?: readonly ResourceRefinement<Input>[],
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, OperationContext>, input: Input, options: InvocationRelationOptions = {}) {
    return this.invocationBuilder.create<Input, Output, Resources>(parent, { input, requires: this.requires, initial: this.definition.run.requires, refinements: this.refinements, observation: this.definition.observation, description: this.definition, work: this.work, key: options.key });
  }
  call(parent: Invocation<unknown, unknown, OperationContext>, input: Input): Promise<Output> {
    return this.create(parent, input).run();
  }
}
