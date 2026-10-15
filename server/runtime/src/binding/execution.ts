import type { ExecutionContext } from '../context/execution.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import { BoundExecution } from '../execution/execution.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { BoundChildren } from './children/bound.js';
import type { ChildBindingOptions } from './contract.js';
import { checkChildDeclarations } from './declarations.js';
import type { OperationBinder } from './operation.js';
import { collectDefinitionRequirements } from './resources.js';
import { bindInvocationWork } from './work.js';

/** Bind an E already checked in its parent declaration graph; O structures remain lazy and local. */
export class ExecutionBinder {
  constructor(
    private readonly invocationBuilder: ExecutionInvocationBuilder,
    private readonly operations: OperationBinder,
    private readonly options: ChildBindingOptions = {},
  ) {}

  bind<Input, Output, Resources extends object, EntryInput, EntryResources extends object>(definition: ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, any, any>): BoundExecution<Input, Output, Resources, EntryInput, EntryResources> {
    const requires = collectDefinitionRequirements(definition, this.options.observationProvides) as ResourceRequirements<Resources>;
    checkChildDeclarations(requires, definition.children, 'execution', this.options, definition);
    const children = new BoundChildren(definition.children, (child) => {
      if (child.level !== 'operation') throw new Error('Invalid child definition level');
      return this.operations.bind(child);
    });
    const work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>> = bindInvocationWork(definition, children);
    return new BoundExecution(this.invocationBuilder, { definition, children, requires, work });
  }
}
