import type { CheckpointBinding } from '../../checkpoint/work.js';
import type { ChildDefinition, DefinitionEntryInput, DefinitionInvocationInput, DefinitionOutput, DefinitionParentInvocationView, DefinitionContextFacts } from '../../definition/children.js';
import type { InvocationEntry } from '../../definition/entry.js';
import type { ParentInvocation } from '../../invocation/children.js';
import type { InvocationRelationOptions, InvocationTarget } from '../../invocation/relation.js';
import type { ChildInvocationView, InvocationView } from '../../invocation/view.js';
import type { BoundChildren } from './bound.js';
import type { ChildBinding, ChildBindings, ChildInvocationOptions } from './contract.js';

export interface ChildBindingsParent extends ParentInvocation {
  readonly view: InvocationView;
  reject(error: unknown, allowException?: boolean): void;
  requireHealthy(): void;
  restoreChild(contract: CheckpointBinding, contextId: string, create: () => InvocationTarget): InvocationTarget;
}

interface InvocationChildBindingsOptions {
  readonly children: BoundChildren;
  readonly parent: ChildBindingsParent;
  readonly view: InvocationView;
  readonly allowed: ReadonlySet<ChildDefinition>;
  readonly validate?: () => void;
  readonly calls: Map<InvocationView, InvocationTarget>;
}

/** One phase's child access. Internal references never appear on the business surface. */
export class InvocationChildBindings implements ChildBindings {
  readonly #children: BoundChildren;
  readonly #parent: ChildBindingsParent;
  readonly #view: InvocationView;
  readonly #allowed: ReadonlySet<ChildDefinition>;
  readonly #validate?: () => void;
  readonly #calls: Map<InvocationView, InvocationTarget>;

  constructor(binding: InvocationChildBindingsOptions) {
    this.#children = binding.children;
    this.#parent = binding.parent;
    this.#view = binding.view;
    this.#allowed = binding.allowed;
    this.#validate = binding.validate;
    this.#calls = binding.calls;
    Object.freeze(this);
  }

  readonly get = <Definition extends ChildDefinition>(definition: Definition): ChildBinding<Definition> => {
    try {
      this.#requireDeclared(definition);
      return Object.freeze({
        create: (actual: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>, options?: ChildInvocationOptions<Definition>) => this.#create(definition, actual, input, options),
        call: (actual: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>) => this.#create(definition, actual, input).run(),
        resume: (actual: DefinitionParentInvocationView<Definition>, contextId: string) => this.#resume(definition, actual, contextId),
      }) as ChildBinding<Definition>;
    } catch (error) {
      this.#parent.reject(error);
      throw error;
    }
  };

  readonly entry = <Definition extends ChildDefinition, EntryInput>(entry: InvocationEntry<Definition, EntryInput>) =>
    Object.freeze({
      create: (actual: DefinitionParentInvocationView<Definition>, input: EntryInput, options: ChildInvocationOptions<Definition> = {}) => this.#createEntry(entry, actual, input, options),
    });

  readonly accept = async <Output, Value>(child: ChildInvocationView<unknown, Output>, work: (delivered: NoInfer<Output>) => Value | Promise<Value>): Promise<Value> => {
    let rejected: { error: unknown } | undefined;
    try {
      this.#checkActive();
      const invocation = this.#calls.get(child) as InvocationTarget<Output> | undefined;
      if (!invocation) throw new Error('Invocation is not a child created through this binding');
      return await this.#parent.children.get(invocation).accept(async (delivered) => {
        // Access failures belong to the binding, not to the declared reception work.
        this.#checkActive();
        try {
          return await work(delivered);
        } catch (error) {
          rejected = { error };
          throw error;
        }
      });
    } catch (error) {
      this.#parent.reject(error, !!rejected && rejected.error === error);
      throw error;
    }
  };

  readonly requireActive = (): void => {
    try {
      this.#checkActive();
    } catch (error) {
      this.#parent.reject(error);
      throw error;
    }
  };

  #create(definition: ChildDefinition, actual: InvocationView, input: unknown, options?: InvocationRelationOptions) {
    try {
      this.#requireOwner(actual);
      this.#checkActive();
      this.#requireDeclared(definition);
      const child = this.#children.get(definition);
      const invocation = child.create(this.#parent, input, options);
      this.#calls.set(invocation.callView, invocation);
      return invocation.callView;
    } catch (error) {
      this.#parent.reject(error);
      throw error;
    }
  }

  #resume(definition: ChildDefinition, actual: InvocationView, contextId: string): ChildInvocationView {
    try {
      this.#requireOwner(actual);
      this.#checkActive();
      this.#requireDeclared(definition);
      const checkpoint = this.#children.checkpoint(definition);
      if (!checkpoint) throw new Error('Child declaration does not support checkpoints');
      // A saved final delivery does not need a bound child structure or a new invocation.
      const invocation = this.#parent.restoreChild(checkpoint, contextId, () => this.#children.get(definition).resume(this.#parent, contextId));
      if (!invocation.callView) throw new Error('Restored child has no public invocation view');
      this.#calls.set(invocation.callView, invocation);
      return invocation.callView;
    } catch (error) {
      this.#parent.reject(error);
      throw error;
    }
  }

  #createEntry<Definition extends ChildDefinition, EntryInput>(entry: InvocationEntry<Definition, EntryInput>, actual: DefinitionParentInvocationView<Definition>, input: EntryInput, options: ChildInvocationOptions<Definition>): ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>> {
    let accepted: DefinitionEntryInput<Definition>;
    try {
      this.#requireOwner(actual);
      this.#checkActive();
      this.#requireDeclared(entry.definition);
      accepted = entry.accept(actual, input, options);
    } catch (error) {
      this.#parent.reject(error);
      throw error;
    }
    // Entry acceptance can change activity; construction checks it again.
    return this.#create(entry.definition, actual, accepted, options) as ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>>;
  }

  #requireDeclared(definition: ChildDefinition): void {
    if (!this.#allowed.has(definition)) throw new Error('Child definition is not declared in this binding');
  }

  #requireOwner(actual: InvocationView): void {
    if (actual !== this.#view) throw new Error('Child entry belongs to another parent invocation');
  }

  #checkActive(): void {
    this.#parent.requireHealthy();
    this.#validate?.();
    this.#parent.context.requireRunning();
    if ('requireActive' in this.#parent.context) (this.#parent.context as { requireActive(): void }).requireActive();
  }
}
