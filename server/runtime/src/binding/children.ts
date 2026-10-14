import type { ParentInvocation } from '../invocation/children.js';
import { Initializer } from '../initialization/initializer.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildDefinition, DefinitionEntryInput, DefinitionInvocationInput, DefinitionOutput, DefinitionParentInvocationView, DefinitionContextFacts, DefinitionDelta } from '../definition/children.js';
import type { Invocation } from '../invocation/invocation.js';
import type { ChildInvocationView, InvocationView } from '../invocation/view.js';
import type { InvocationRelationOptions, InvocationTarget } from '../invocation/relation.js';
import type { CheckpointBinding } from '../checkpoint/work.js';

import type { InvocationOutputReceiver } from '../output/contract.js';

export interface ChildInvocationOptions<Definition extends ChildDefinition> extends InvocationRelationOptions {
  output?: InvocationOutputReceiver<DefinitionOutput<Definition>, DefinitionDelta<Definition>>;
}

interface StoredChild {
  create(parent: any, input: any, options?: InvocationRelationOptions): Invocation<any, any, any>;
  resume(parent: any, contextId: string, options?: InvocationRelationOptions): Invocation<any, any, any>;
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

/** Initialized nodes are shared; views and created calls belong to one parent invocation. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildDefinition, Initializer<StoredChild>>;
  constructor(definitions: readonly ChildDefinition[], create: (definition: ChildDefinition) => StoredChild) {
    this.#entries = new Map(definitions.map((definition) => [definition, new Initializer(() => create(definition))]));
  }
  get<Definition extends ChildDefinition>(definition: Definition): StoredChild {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.get();
  }
  checkUses(definitions: readonly ChildDefinition[]): void {
    for (const definition of definitions) if (!this.#entries.has(definition)) throw new Error('Declaration uses a child outside its owner');
  }
  initialized(definition: ChildDefinition): boolean {
    return this.#entries.get(definition)?.initialized ?? false;
  }
  forInvocation(parent: ParentInvocation & { readonly view: InvocationView; reject(error: unknown, allowException?: boolean): void; requireHealthy(): void; restoreChild(contract: CheckpointBinding, contextId: string, create: () => InvocationTarget): InvocationTarget }, view: InvocationView = parent.view, uses?: readonly ChildDefinition[], validate?: () => void, calls = new Map<InvocationView, InvocationTarget>()): ChildBindings {
    const allowed = new Set(uses ?? this.#entries.keys());
    const protect = <Value>(work: () => Value): Value => {
      try {
        return work();
      } catch (error) {
        parent.reject(error);
        throw error;
      }
    };
    const requireActive = () =>
      protect(() => {
        parent.requireHealthy();
        validate?.();
        parent.context.requireRunning();
        if ('requireActive' in parent.context) (parent.context as { requireActive(): void }).requireActive();
      });
    const create = (definition: ChildDefinition, actual: InvocationView, input: unknown, options?: InvocationRelationOptions) =>
      protect(() => {
        if (actual !== view) throw new Error('Child entry belongs to another parent invocation');
        requireActive();
        if (!allowed.has(definition)) throw new Error('Child definition is not declared for this phase');
        const invocation = this.get(definition).create(parent, input, options);
        calls.set(invocation.callView, invocation);
        return invocation.callView;
      });
    return Object.freeze({
      get: <Definition extends ChildDefinition>(definition: Definition) =>
        protect(() => {
          if (!this.#entries.has(definition) || !allowed.has(definition)) throw new Error('Child definition is not declared in this binding');
          return Object.freeze({
            create: (actual: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>, options?: ChildInvocationOptions<Definition>) => create(definition, actual, input, options),
            call: (actual: DefinitionParentInvocationView<Definition>, input: DefinitionEntryInput<Definition>) => create(definition, actual, input).run(),
            resume: (actual: DefinitionParentInvocationView<Definition>, contextId: string) =>
              protect(() => {
                if (actual !== view) throw new Error('Child entry belongs to another parent invocation');
                requireActive();
                const checkpoint = definition.checkpoint;
                if (!checkpoint) throw new Error('Child declaration does not support checkpoints');
                const invocation = parent.restoreChild(checkpoint, contextId, () => this.get(definition).resume(parent, contextId));
                if (!invocation.callView) throw new Error('Restored child has no public invocation view');
                calls.set(invocation.callView, invocation);
                return invocation.callView;
              }),
          }) as ChildBinding<Definition>;
        }),
      entry: <Definition extends ChildDefinition, EntryInput>(entry: InvocationEntry<Definition, EntryInput>) =>
        Object.freeze({
          create: (actual: DefinitionParentInvocationView<Definition>, input: EntryInput, options: ChildInvocationOptions<Definition> = {}) =>
            protect(() => {
              if (actual !== view) throw new Error('Child entry belongs to another parent invocation');
              requireActive();
              if (!this.#entries.has(entry.definition) || !allowed.has(entry.definition)) throw new Error('Child definition is not declared in this binding');
              return create(entry.definition, actual, entry.accept(actual, input, options), options) as ChildInvocationView<DefinitionInvocationInput<Definition>, DefinitionOutput<Definition>, DefinitionContextFacts<Definition>>;
            }),
        }),
      accept: async <Output, Value>(child: ChildInvocationView<unknown, Output>, work: (delivered: NoInfer<Output>) => Value | Promise<Value>) => {
        let rejected: { error: unknown } | undefined;
        try {
          requireActive();
          const invocation = calls.get(child) as InvocationTarget<Output> | undefined;
          if (!invocation) throw new Error('Invocation is not a child created through this binding');
          return await parent.children.get(invocation).accept(async (delivered) => {
            try {
              requireActive();
              return await work(delivered);
            } catch (error) {
              rejected = { error };
              throw error;
            }
          });
        } catch (error) {
          parent.reject(error, !!rejected && rejected.error === error);
          throw error;
        }
      },
      requireActive,
    });
  }
}
