import type { ChildContract, ChildDefinition, ChildFacts, DefinitionInput } from './children.js';
import type { ContinuationFact } from './work.js';

export interface ChildEntryFacts {
  readonly round: 1 | 2;
  readonly continuation?: ContinuationFact;
  readonly children: ChildFacts;
}
export interface ChildEntryInput<Input> {
  readonly input: Input;
  readonly facts: ChildEntryFacts;
  readonly key?: string;
}

/** Invocation-facing input adaptation; assembly helpers retain the complete definition. */
export interface ChildEntry<Definition extends ChildContract, Input> {
  readonly definition: Definition;
  readonly accept: (request: ChildEntryInput<Input>) => DefinitionInput<Definition>;
}

/** An alternative input contract; binding owns admission and the real parent identity. */
export class InvocationEntry<Definition extends ChildDefinition, EntryInput> implements ChildEntry<Definition, EntryInput> {
  constructor(
    readonly definition: Definition,
    readonly accept: (request: ChildEntryInput<EntryInput>) => DefinitionInput<Definition>,
  ) {
    Object.freeze(this);
  }
  get run() {
    return this.definition.run;
  }
  get exceptions() {
    return this.definition.exceptions;
  }
}

export function defineChildEntry<Definition extends ChildDefinition, Input>(definition: Definition, entry: { readonly accept: (request: ChildEntryInput<Input>) => NoInfer<DefinitionInput<Definition>> }): InvocationEntry<Definition, Input> {
  return new InvocationEntry(definition, entry.accept.bind(entry));
}
