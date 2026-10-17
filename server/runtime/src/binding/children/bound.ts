import { Initializer } from '../../initializer.js';
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
  readonly #entries: ReadonlyMap<ChildDefinition, { readonly level: ChildDefinition['level']; readonly value: Initializer<StoredChild>; readonly checkpoint?: CheckpointBinding }>;
  readonly #definitions: readonly ChildDefinition[];

  constructor(children: readonly ResolvedChild[], create: (child: ResolvedChild) => StoredChild) {
    this.#entries = new Map(children.map((child) => [child.definition, { level: child.declaration.level, value: new Initializer(() => create(child)), checkpoint: child.declaration.checkpoint }]));
    this.#definitions = Object.freeze([...this.#entries.keys()]);
  }

  definitions(): readonly ChildDefinition[] {
    return this.#definitions;
  }

  position(definition: ChildDefinition): number {
    const position = this.#definitions.indexOf(definition);
    if (position < 0) throw new Error('Child definition is not declared in this binding');
    return position;
  }

  at(position: number): ChildDefinition {
    const definition = this.#definitions[position];
    if (!Number.isSafeInteger(position) || !definition) throw new Error('Child declaration position is not registered');
    return definition;
  }

  /** Durable declaration association is independent of lazy Bound initialization. */
  checkpointLayout() {
    return Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({ level: entry.level, binding: entry.checkpoint })));
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
