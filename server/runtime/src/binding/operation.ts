import type { OperationContext } from '../context/operation.js';
import type { ChildDefinition } from '../definition/children.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import { BoundOperation } from '../operation/operation.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { AttemptBinder } from './attempt.js';
import { BoundChildren } from './children/bound.js';
import type { ChildBindingOptions } from './contract.js';
import { checkChildDeclarations } from './declarations.js';
import { collectDefinitionRequirements } from './resources.js';
import { bindInvocationWork } from './work.js';

/** Bind an O already checked in its parent declaration graph and delegate its direct O/A structures. */
export class OperationBinder {
  constructor(
    private readonly invocationBuilder: OperationInvocationBuilder,
    private readonly attempts: AttemptBinder,
    private readonly options: ChildBindingOptions = {},
  ) {}

  bind<Input, Output, Resources extends object>(definition: OperationDefinition<Input, Output, Resources, any, any>): BoundOperation<Input, Output, Resources> {
    const requires = collectDefinitionRequirements(definition, this.options.observationProvides) as ResourceRequirements<Resources>;
    checkChildDeclarations(requires, definition.children, 'operation', this.options, definition);
    const children = new BoundChildren(definition.children, (child) => this.bindChild(child));
    const refinements = this.options.childResources?.find((binding) => binding.definition === definition)?.refinements;
    const work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>> = bindInvocationWork(definition, children);
    return new BoundOperation(this.invocationBuilder, { definition, children, requires, refinements, work });
  }

  private bindChild(definition: ChildDefinition) {
    switch (definition.level) {
      case 'operation':
        return this.bind(definition);
      case 'attempt':
        return this.attempts.bind(definition);
      default:
        throw new Error('Invalid child definition level');
    }
  }
}
