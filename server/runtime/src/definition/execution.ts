import { InvocationDefinition } from './invocation.js';
import type { ExecutionScope } from '../context/scope.js';
import type { OperationDefinition } from './operation.js';
import type { ResourceRequirements } from '../resource/bindings.js';

export interface ExecutionEntry<U, I, R extends object> {
  readonly requires: ResourceRequirements<R>;
  accept(input: U, resources: Readonly<R>): I;
  admit?(input: I, resources: Readonly<R>): void;
}

export abstract class ExecutionDefinition<I, O, R extends object = Record<string, never>, U = I, ER extends object = Record<string, never>> extends InvocationDefinition<I, O, ExecutionScope<I, O, R>, R> {
  readonly level = 'execution' as const;
  readonly children: readonly OperationDefinition<any, any, any>[] = [];
  readonly entry?: ExecutionEntry<U, I, ER>;
}
