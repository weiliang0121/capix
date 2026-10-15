import type { OperationContext } from '../context/operation.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { InvocationWork } from '../invocation/work.js';
import type { OperationInvocationBuilder } from '../invocation/builders/operation.js';
import { BoundOperation } from '../operation/operation.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { AttemptBinder } from './attempt.js';
import { BoundChildren } from './children/bound.js';
import type { ChildBindingOptions } from './contract.js';
import { resolveDeclaration, type ResolvedOperation, type ResolvedChild } from './declarations.js';
import { InvocationWorkBinding } from './work.js';

/** Bind an O already checked in its parent declaration graph and delegate its direct O/A structures. */
export class OperationBinder {
  constructor(
    private readonly invocationBuilder: OperationInvocationBuilder,
    private readonly attempts: AttemptBinder,
    private readonly options: ChildBindingOptions = {},
  ) {}

  bind<Input, Output, Resources extends object>(definition: OperationDefinition<Input, Output, Resources, any, any>): BoundOperation<Input, Output, Resources> {
    return this.bindResolved(resolveDeclaration(definition, this.options));
  }

  /** Consume this position's resolved graph without reading or checking the original declaration again. */
  bindResolved<Input, Output, Resources extends object>(resolved: ResolvedOperation<Input, Output, Resources>): BoundOperation<Input, Output, Resources> {
    const definition = resolved.definition;
    const declaration = resolved.declaration;
    const requires = resolved.requires as ResourceRequirements<Resources>;
    const children = new BoundChildren(resolved.children, (child) => this.bindChild(child));
    const refinements = resolved.refinements;
    const work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>> = new InvocationWorkBinding(declaration, children);
    return new BoundOperation(this.invocationBuilder, { definition, declaration, children, requires, refinements, work });
  }

  private bindChild(resolved: ResolvedChild) {
    switch (resolved.level) {
      case 'operation':
        return this.bindResolved(resolved);
      case 'attempt':
        return this.attempts.bindResolved(resolved);
      default:
        throw new Error('Invalid child definition level');
    }
  }
}
