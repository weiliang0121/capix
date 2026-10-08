import type { ParentInvocation } from '../invocation/children.js';
import { Initializer } from '../initialization/initializer.js';
import { InvocationEntry } from '../definition/entry.js';
import type { ChildDefinition, DefinitionInput, DefinitionOutput, DefinitionParent, DefinitionContext } from '../definition/children.js';
import type { Invocation } from '../invocation/invocation.js';
import type { InvocationTarget } from '../invocation/relation.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';

export interface BoundChild<D extends ChildDefinition> {
  readonly id?: string;
  create(parent: DefinitionParent<D>, input: DefinitionInput<D>, options?: InvocationRelationOptions): Invocation<DefinitionInput<D>, DefinitionOutput<D>, DefinitionContext<D>>;
  call(parent: DefinitionParent<D>, input: DefinitionInput<D>): Promise<DefinitionOutput<D>>;
}

interface StoredChild {
  create(parent: any, input: any, options?: InvocationRelationOptions): InvocationTarget<any>;
  call(parent: any, input: any): Promise<any>;
}

/** Only the declared direct children are resolvable; no runtime-wide fallback. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildDefinition, Initializer<StoredChild>>;
  constructor(
    private readonly definitions: readonly ChildDefinition[],
    create: (definition: ChildDefinition) => StoredChild,
    private readonly parent?: ParentInvocation,
  ) {
    this.#entries = new Map(definitions.map((definition) => [definition, new Initializer(() => create(definition))]));
  }
  forInvocation(parent: ParentInvocation): ChildBindings {
    return new BoundChildren(
      this.definitions,
      (definition) => {
        const child = this.get(definition);
        const create = (actual: ParentInvocation, input: unknown, options?: InvocationRelationOptions) => {
          if (actual !== parent) throw new Error('Child entry belongs to another parent invocation');
          parent.context.requireRunning();
          return child.create(actual as DefinitionParent<ChildDefinition>, input, options);
        };
        return { create, call: async (actual, input) => create(actual, input).run() };
      },
      parent,
    );
  }
  get<D extends ChildDefinition>(definition: D): BoundChild<D> {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.get() as unknown as BoundChild<D>;
  }
  initialized(definition: ChildDefinition): boolean {
    return this.#entries.get(definition)?.initialized ?? false;
  }
  entry<D extends ChildDefinition, I>(entry: InvocationEntry<D, I>) {
    return {
      create: (parent: DefinitionParent<D>, input: I, options: InvocationRelationOptions = {}) => {
        // Check ownership and membership before running application admission logic.
        if (this.parent && parent !== this.parent) throw new Error('Child entry belongs to another parent invocation');
        parent.context.requireActive();
        if (!this.#entries.has(entry.definition)) throw new Error('Child definition is not declared in this binding');
        const accepted = entry.accept(parent, input, options);
        return this.get(entry.definition).create(parent, accepted, options);
      },
    };
  }
}

/** Per-call view exposed to content, without construction or rescoping methods. */
export type ChildBindings = Pick<BoundChildren, 'get' | 'entry'>;
