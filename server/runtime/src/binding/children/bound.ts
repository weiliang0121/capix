import { Initializer } from '../../initialization/initializer.js';
import type { ChildDefinition } from '../../definition/children.js';
import type { Invocation } from '../../invocation/invocation.js';
import type { InvocationRelationOptions } from '../../invocation/relation.js';

interface StoredChild {
  create(parent: any, input: any, options?: InvocationRelationOptions): Invocation<any, any, any>;
  resume(parent: any, contextId: string, options?: InvocationRelationOptions): Invocation<any, any, any>;
}

/** Reusable child structures; no parent invocation or phase access is retained here. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildDefinition, Initializer<StoredChild>>;

  constructor(definitions: readonly ChildDefinition[], create: (definition: ChildDefinition) => StoredChild) {
    this.#entries = new Map(definitions.map((definition) => [definition, new Initializer(() => create(definition))]));
  }

  definitions(): readonly ChildDefinition[] {
    return Object.freeze([...this.#entries.keys()]);
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
}
