import type { invocationSignature } from './signature.js';
import type { DefinitionParent } from './children.js';
import { InvocationDefinition } from './invocation.js';
import type { AttemptContext } from '../context/attempt.js';

export abstract class AttemptDefinition<I, O, R extends object = Record<string, never>> extends InvocationDefinition<I, O, AttemptContext<I, O, R>, R> {
  declare readonly [invocationSignature]?: (parent: DefinitionParent<AttemptDefinition<I, O, R>>, input: I) => O;
  readonly level = 'attempt' as const;
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;
}
