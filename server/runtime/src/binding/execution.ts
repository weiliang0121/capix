import type { ExecutionContext } from '../context/execution.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import { BoundExecution } from '../execution/execution.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { BoundChildren } from './children/bound.js';
import type { ChildBindingOptions } from './contract.js';
import type { OperationBinder } from './operation.js';
import { resolveDeclaration, type ResolvedExecution } from './declarations.js';
import { bindInvocationWork } from './work.js';

/** Bind an E already checked in its parent declaration graph; O structures remain lazy and local. */
export class ExecutionBinder {
  constructor(
    private readonly invocationBuilder: ExecutionInvocationBuilder,
    private readonly operations: OperationBinder,
    private readonly options: ChildBindingOptions = {},
  ) {}

  bind<Input, Output, Resources extends object, EntryInput, EntryResources extends object>(definition: ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, any, any>): BoundExecution<Input, Output, Resources, EntryInput, EntryResources> {
    return this.bindResolved(resolveDeclaration(definition, this.options));
  }

  /** Consume this position's resolved graph without reading or checking the original declaration again. */
  bindResolved<Input, Output, Resources extends object, EntryInput, EntryResources extends object>(resolved: ResolvedExecution<Input, Output, Resources, EntryInput, EntryResources>): BoundExecution<Input, Output, Resources, EntryInput, EntryResources> {
    const definition = resolved.definition;
    const declaration = resolved.declaration;
    const requires = resolved.requires as ResourceRequirements<Resources>;
    const children = new BoundChildren(resolved.children, (child) => {
      if (child.level !== 'operation') throw new Error('Invalid child definition level');
      return this.operations.bindResolved(child);
    });
    const work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>> = bindInvocationWork(declaration, children);
    return new BoundExecution(this.invocationBuilder, { definition, declaration, children, requires, work });
  }
}
