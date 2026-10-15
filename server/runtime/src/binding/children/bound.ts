import { Initializer } from '../../initialization/initializer.js';
import type { ChildDefinition } from '../../definition/children.js';
import type { Invocation } from '../../invocation/invocation.js';
import type { InvocationRelationOptions } from '../../invocation/relation.js';
import type { CheckpointBinding } from '../../checkpoint/work.js';
import type { ResolvedChild } from '../declarations.js';

interface StoredChild {
  create(parent: any, input: any, options?: InvocationRelationOptions): Invocation<any, any, any>;
  resume(parent: any, contextId: string, options?: InvocationRelationOptions): Invocation<any, any, any>;
}

/** Reusable child structures; no parent invocation or phase access is retained here. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildDefinition, { readonly value: Initializer<StoredChild>; readonly checkpoint?: CheckpointBinding }>;

  constructor(children: readonly ResolvedChild[], create: (child: ResolvedChild) => StoredChild) {
    this.#entries = new Map(children.map((child) => [child.definition, { value: new Initializer(() => create(child)), checkpoint: child.declaration.checkpoint }]));
  }

  definitions(): readonly ChildDefinition[] {
    return Object.freeze([...this.#entries.keys()]);
  }

  get<Definition extends ChildDefinition>(definition: Definition): StoredChild {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.value.get();
  }

  checkpoint(definition: ChildDefinition): CheckpointBinding | undefined {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.checkpoint;
  }

  checkUses(definitions: readonly ChildDefinition[]): void {
    for (const definition of definitions) if (!this.#entries.has(definition)) throw new Error('Declaration uses a child outside its owner');
  }

  initialized(definition: ChildDefinition): boolean {
    return this.#entries.get(definition)?.value.initialized ?? false;
  }
}
