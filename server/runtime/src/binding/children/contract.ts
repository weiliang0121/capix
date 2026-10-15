import type { InvocationEntry } from '../../definition/entry.js';
import type { ChildDefinition, DefinitionEntryInput, DefinitionInvocationInput, DefinitionOutput, DefinitionParentInvocationView, DefinitionContextFacts, DefinitionDelta } from '../../definition/children.js';
import type { ChildInvocationView } from '../../invocation/view.js';
import type { InvocationRelationOptions } from '../../invocation/relation.js';
import type { InvocationOutputReceiver } from '../../output/contract.js';

export interface ChildInvocationOptions<Definition extends ChildDefinition> extends InvocationRelationOptions {
  output?: InvocationOutputReceiver<DefinitionOutput<Definition>, DefinitionDelta<Definition>>;
}

export interface ChildBinding<Definition extends ChildDefinition> {
  create(parent: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>, options?: ChildInvocationOptions<Definition>): ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>>;
  call(parent: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>): Promise<DefinitionOutput<Definition>>;
  resume(parent: DefinitionParentInvocationView<Definition>, contextId: string): ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>>;
}

/** A business capability for this parent's declared children only. */
export interface ChildBindings {
  get<Definition extends ChildDefinition>(definition: Definition): ChildBinding<Definition>;
  entry<Definition extends ChildDefinition, EntryInput>(entry: InvocationEntry<Definition, EntryInput>): { create(parent: DefinitionParentInvocationView<Definition>, input: EntryInput, options?: ChildInvocationOptions<Definition>): ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>> };
  /** Receive this child's actual successful delivery before choosing the next work. */
  accept<Output, Value>(child: ChildInvocationView<unknown, Output>, work: (delivered: NoInfer<Output>) => Value | Promise<Value>): Promise<Value>;
  requireActive(): void;
}
