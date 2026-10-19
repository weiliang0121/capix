import { InvocationDefinition } from './invocation.js';
import type { DefinitionChildren } from './children.js';

export abstract class OperationDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'operation', Resources, ExceptionResources, Delta> implements DefinitionChildren<'operation'> {
  readonly level = 'operation' as const;
  readonly children: DefinitionChildren<'operation'>['children'] = [];
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
}
