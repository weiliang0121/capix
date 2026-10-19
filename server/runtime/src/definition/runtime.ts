import { InvocationDefinition } from './invocation.js';
import type { DefinitionChildren } from './children.js';

/** R declares work over its available E nodes; supplies remain an assembly concern. */
export abstract class RuntimeDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'runtime', Resources, ExceptionResources, Delta> implements DefinitionChildren<'runtime'> {
  readonly level = 'runtime' as const;
  readonly children: DefinitionChildren<'runtime'>['children'] = [];
}
