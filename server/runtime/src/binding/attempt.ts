import { BoundAttempt } from '../attempt/attempt.js';
import type { AttemptContext } from '../context/attempt.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { BoundChildren } from './children/bound.js';
import type { ChildBindingOptions } from './contract.js';
import { collectDefinitionRequirements } from './resources.js';
import { bindInvocationWork } from './work.js';

/** Bind an A already checked in its parent declaration graph; leaves expose no child construction. */
export class AttemptBinder {
  constructor(
    private readonly invocationBuilder: AttemptInvocationBuilder,
    private readonly options: ChildBindingOptions = {},
  ) {}

  bind<Input, Output, Resources extends object>(definition: AttemptDefinition<Input, Output, Resources, any, any>): BoundAttempt<Input, Output, Resources> {
    const requires = collectDefinitionRequirements(definition, this.options.observationProvides) as ResourceRequirements<Resources>;
    const children = new BoundChildren([], () => {
      throw new Error('Attempts cannot have children');
    });
    const refinements = this.options.childResources?.find((binding) => binding.definition === definition)?.refinements;
    const work: InvocationWork<Input, Output, AttemptContext<Input, Output, Resources>> = bindInvocationWork(definition, children);
    return new BoundAttempt(this.invocationBuilder, { definition, children, requires, refinements, work });
  }
}
