import type { ResourceRequirements } from '../resource/bindings.js';
import { definitionResources } from '../definition/invocation.js';
import type { Invocation } from '../invocation/invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { AttemptContext } from '../context/attempt.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { BoundChildren } from '../binding/children.js';
import { bindInvocationWork } from '../binding/work.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** A bound leaf node: fixed call mechanics and explicitly supplied content. */
export class Attempt<I, O, R extends object = object> {
  private readonly work: InvocationWork<AttemptContext<I, O, R>, I, O>;
  constructor(
    private readonly invocations: AttemptInvocationBuilder,
    readonly definition: AttemptDefinition<I, O, R, any>,
    children: BoundChildren,
    private readonly requires: ResourceRequirements<R> = definitionResources(definition) as ResourceRequirements<R>,
  ) {
    this.work = bindInvocationWork(definition, children);
  }
  create(parent: Invocation<unknown, unknown, OperationContext>, input: I, options: InvocationRelationOptions = {}) {
    return this.invocations.create<I, O, R>(parent, { input, requires: this.requires, initial: this.definition.run.requires, observation: this.definition.observation, description: this.definition, work: this.work, key: options.key });
  }
  call(parent: Invocation<unknown, unknown, OperationContext>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
