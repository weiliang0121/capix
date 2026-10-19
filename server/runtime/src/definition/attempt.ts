import { InvocationDefinition } from './invocation.js';
import type { DefinitionChildren } from './children.js';

export abstract class AttemptDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'attempt', Resources, ExceptionResources, Delta> implements DefinitionChildren<'attempt'> {
  readonly level = 'attempt' as const;
  declare readonly children?: never;
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;
}
