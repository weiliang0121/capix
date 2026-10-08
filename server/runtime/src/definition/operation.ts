import type { invocationSignature } from './signature.js';
import type { DefinitionParent } from './children.js';
import { InvocationDefinition } from './invocation.js';
import type { OperationContext } from '../context/operation.js';
import type { ChildDefinition } from './children.js';

export abstract class OperationDefinition<I, O, R extends object = Record<string, never>> extends InvocationDefinition<I, O, OperationContext<I, O, R>, R> {
  declare readonly [invocationSignature]?: (parent: DefinitionParent<OperationDefinition<I, O, R>>, input: I) => O;
  readonly level = 'operation' as const;
  readonly children: readonly ChildDefinition[] = [];
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
}
