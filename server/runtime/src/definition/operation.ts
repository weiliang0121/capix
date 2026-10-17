import { InvocationDefinition } from './invocation.js';
import type { AttemptDefinition } from './attempt.js';

export abstract class OperationDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'operation', Resources, ExceptionResources, Delta> {
  readonly level = 'operation' as const;
  readonly children: readonly (OperationDefinition<any, any, any, any, any> | AttemptDefinition<any, any, any, any, any>)[] = [];
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
}
