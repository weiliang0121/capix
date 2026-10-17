import { InvocationDefinition } from './invocation.js';

export abstract class AttemptDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends InvocationDefinition<Input, Output, 'attempt', Resources, ExceptionResources, Delta> {
  readonly level = 'attempt' as const;
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;
}
