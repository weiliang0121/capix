import { InvocationDefinition } from './invocation.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationDefinition } from './operation.js';

export abstract class ExecutionDefinition<I, O, R extends object = Record<string, never>> extends InvocationDefinition<I, O, ExecutionContext<I, O, R>, R> {
  readonly level = 'execution' as const;
  readonly children: readonly OperationDefinition<any, any, any>[] = [];
}
