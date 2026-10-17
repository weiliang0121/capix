import { InvocationDefinition } from './invocation.js';
import type { OperationDefinition } from './operation.js';
import type { ResourceRequirements } from '../resource/bindings.js';

export interface ExecutionEntry<EntryInput, Input, EntryResources extends object> {
  readonly requires: ResourceRequirements<EntryResources>;
  accept(input: EntryInput, resources: Readonly<EntryResources>): Input;
  admit?(input: Input, resources: Readonly<EntryResources>): void;
}

export abstract class ExecutionDefinition<Input, Output, Resources extends object = Record<string, never>, EntryInput = Input, EntryResources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'execution', Resources, ExceptionResources, Delta, EntryInput> {
  readonly level = 'execution' as const;
  readonly children: readonly OperationDefinition<any, any, any, any, any>[] = [];
  readonly entry?: ExecutionEntry<EntryInput, Input, EntryResources>;
}
