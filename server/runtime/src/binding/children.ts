import type { ParentInvocation } from '../invocation/children.js';
import { Initializer } from '../initialization/initializer.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildDefinition, DefinitionInput, DefinitionOutput, DefinitionParent, DefinitionContext } from '../definition/children.js';
import type { Invocation } from '../invocation/invocation.js';
import type { ChildCall, InvocationView } from '../invocation/view.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

interface StoredChild {
  create(parent: any, input: any, options?: InvocationRelationOptions): Invocation<any, any, any>;
}

export interface BoundChild<D extends ChildDefinition> {
  create(parent: DefinitionParent<D>, input: DefinitionInput<D>, options?: InvocationRelationOptions): ChildCall<DefinitionInput<D>, DefinitionOutput<D>, DefinitionContext<D>>;
  call(parent: DefinitionParent<D>, input: DefinitionInput<D>): Promise<DefinitionOutput<D>>;
}

/** A business capability for this parent's declared children only. */
export interface ChildBindings {
  get<D extends ChildDefinition>(definition: D): BoundChild<D>;
  entry<D extends ChildDefinition, I>(entry: InvocationEntry<D, I>): { create(parent: DefinitionParent<D>, input: I, options?: InvocationRelationOptions): ChildCall<DefinitionInput<D>, DefinitionOutput<D>, DefinitionContext<D>> };
  accept<T>(child: InvocationView, work: () => T | Promise<T>): Promise<T>;
  requireActive(): void;
}

/** Initialized nodes are shared; views and created calls belong to one parent invocation. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildDefinition, Initializer<StoredChild>>;
  constructor(definitions: readonly ChildDefinition[], create: (definition: ChildDefinition) => StoredChild) {
    this.#entries = new Map(definitions.map((definition) => [definition, new Initializer(() => create(definition))]));
  }
  get<D extends ChildDefinition>(definition: D): StoredChild {
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
  forInvocation(parent: ParentInvocation & { readonly view: InvocationView; reject(error: unknown, allowException?: boolean): void; requireHealthy(): void }, view: InvocationView = parent.view, uses?: readonly ChildDefinition[], validate?: () => void): ChildBindings {
    const calls = new Map<InvocationView, Invocation<any, any, any>>();
    const allowed = new Set(uses ?? this.#entries.keys());
    const protect = <T>(work: () => T): T => {
      try {
        return work();
      } catch (error) {
        parent.reject(error);
        throw error;
      }
    };
    const requireActive = () =>
      protect(() => {
        validate?.();
        parent.requireHealthy();
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
      get: <D extends ChildDefinition>(definition: D) =>
        protect(() => {
          if (!this.#entries.has(definition) || !allowed.has(definition)) throw new Error('Child definition is not declared in this binding');
          return Object.freeze({
            create: (actual: DefinitionParent<D>, input: DefinitionInput<D>, options?: InvocationRelationOptions) => create(definition, actual, input, options),
            call: (actual: DefinitionParent<D>, input: DefinitionInput<D>) => create(definition, actual, input).run(),
          }) as BoundChild<D>;
        }),
      entry: <D extends ChildDefinition, I>(entry: InvocationEntry<D, I>) =>
        Object.freeze({
          create: (actual: DefinitionParent<D>, input: I, options: InvocationRelationOptions = {}) =>
            protect(() => {
              if (actual !== view) throw new Error('Child entry belongs to another parent invocation');
              requireActive();
              if (!this.#entries.has(entry.definition) || !allowed.has(entry.definition)) throw new Error('Child definition is not declared in this binding');
              return create(entry.definition, actual, entry.accept(actual, input, options), options) as ChildCall<DefinitionInput<D>, DefinitionOutput<D>, DefinitionContext<D>>;
            }),
        }),
      accept: async <T>(child: InvocationView, work: () => T | Promise<T>) => {
        let rejected: { error: unknown } | undefined;
        try {
          requireActive();
          const invocation = calls.get(child);
          if (!invocation) throw new Error('Invocation is not a child created through this binding');
          return await parent.children.get(invocation).accept(async () => {
            try {
              return await work();
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
