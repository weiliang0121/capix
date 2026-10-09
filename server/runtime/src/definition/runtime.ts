import { InvocationDefinition } from './invocation.js';
import type { RuntimeScope } from '../context/scope.js';
import type { ExecutionDefinition } from './execution.js';

/** R declares work over its available E nodes; supplies remain an assembly concern. */
export abstract class RuntimeDefinition<I, O, R extends object = Record<string, never>, H extends object = Record<string, never>> extends InvocationDefinition<I, O, RuntimeScope<I, O, R>, R, H> {
  readonly level = 'runtime' as const;
  readonly children: readonly ExecutionDefinition<any, any, any, any, any, any>[] = [];
}
