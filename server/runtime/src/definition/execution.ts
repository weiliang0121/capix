import { InvocationDefinition } from './invocation.js';
import type { OperationDefinition } from './operation.js';

export abstract class ExecutionDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'execution', Resources, ExceptionResources, Delta> {
  readonly level = 'execution' as const;
  readonly children: readonly OperationDefinition<any, any, any, any, any>[] = [];
}
