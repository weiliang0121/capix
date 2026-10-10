import type { invocationSignature } from './signature.js';
import type { DefinitionOutput } from './children.js';
import type { ChildDefinition, DefinitionEntryInput, DefinitionParentInvocationView } from './children.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

/** An explicit alternative input contract; it cannot construct a call on its own. */
export class InvocationEntry<Definition extends ChildDefinition, EntryInput> {
  declare readonly [invocationSignature]?: (parent: DefinitionParentInvocationView<Definition>, input: EntryInput) => DefinitionOutput<Definition>;
  constructor(
    readonly definition: Definition,
    readonly accept: (parent: DefinitionParentInvocationView<Definition>, input: EntryInput, options: InvocationRelationOptions) => DefinitionEntryInput<Definition>,
  ) {}
  get run() {
    return this.definition.run;
  }
  get exceptions() {
    return this.definition.exceptions;
  }
}
