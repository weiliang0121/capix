import { InvocationDefinition } from './invocation.js';
import type { ExecutionContextView } from '../context/view.js';
import type { OperationDefinition } from './operation.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { invocationSignature } from './signature.js';
import type { DefinitionParentInvocationView } from './children.js';

export interface ExecutionEntry<EntryInput, Input, EntryResources extends object> {
  readonly requires: ResourceRequirements<EntryResources>;
  accept(input: EntryInput, resources: Readonly<EntryResources>): Input;
  admit?(input: Input, resources: Readonly<EntryResources>): void;
}

export abstract class ExecutionDefinition<Input, Output, Resources extends object = Record<string, never>, EntryInput = Input, EntryResources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, ExecutionContextView<Input, Output, Resources>, Resources, ExceptionResources, Delta> {
  declare readonly [invocationSignature]?: (parent: DefinitionParentInvocationView<ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, ExceptionResources>>, input: EntryInput) => Output;
  readonly level = 'execution' as const;
  readonly children: readonly OperationDefinition<any, any, any, any, any>[] = [];
  readonly entry?: ExecutionEntry<EntryInput, Input, EntryResources>;
}
