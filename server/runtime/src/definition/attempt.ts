import type { invocationSignature } from './signature.js';
import type { DefinitionParent } from './children.js';
import { InvocationDefinition } from './invocation.js';
import type { AttemptScope } from '../context/scope.js';

export abstract class AttemptDefinition<I, O, R extends object = Record<string, never>> extends InvocationDefinition<I, O, AttemptScope<I, O, R>, R> {
  declare readonly [invocationSignature]?: (parent: DefinitionParent<AttemptDefinition<I, O, R>>, input: I) => O;
  readonly level = 'attempt' as const;
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;
}
