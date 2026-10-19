import { InvocationDefinition } from './invocation.js';
import type { DefinitionChildren } from './children.js';

export abstract class ExecutionDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'execution', Resources, ExceptionResources, Delta> implements DefinitionChildren<'execution'> {
  readonly level = 'execution' as const;
  readonly children: DefinitionChildren<'execution'>['children'] = [];
}
