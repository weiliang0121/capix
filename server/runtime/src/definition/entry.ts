import type { invocationSignature } from './signature.js';
import type { DefinitionOutput } from './children.js';
import type { ChildDefinition, DefinitionInput, DefinitionParent } from './children.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** An explicit alternative input contract; it cannot construct a call on its own. */
export class InvocationEntry<D extends ChildDefinition, I> {
  declare readonly [invocationSignature]?: (parent: DefinitionParent<D>, input: I) => DefinitionOutput<D>;
  constructor(
    readonly definition: D,
    readonly accept: (parent: DefinitionParent<D>, input: I, options: InvocationRelationOptions) => DefinitionInput<D>,
  ) {}
  get run() {
    return this.definition.run;
  }
  get exceptions() {
    return this.definition.exceptions;
  }
}
