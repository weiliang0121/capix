import { InvocationDefinition } from './invocation.js';
import type { ExecutionDefinition } from './execution.js';

/** R declares work over its available E nodes; supplies remain an assembly concern. */
export abstract class RuntimeDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'runtime', Resources, ExceptionResources, Delta> {
  readonly level = 'runtime' as const;
  readonly children: readonly ExecutionDefinition<any, any, any, any, any>[] = [];
}
