import { Initializer } from '../../initializer.js';
import type { ChildContract, ChildCallable } from '../../definition/children.js';
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
  readonly #entries: ReadonlyMap<ChildContract, { readonly kind: ChildCallable['kind']; readonly value: Initializer<StoredChild>; readonly checkpoint?: CheckpointBinding }>;
  readonly #definitions: readonly ChildCallable[];

  constructor(children: readonly ResolvedChild[], create: (child: ResolvedChild) => StoredChild) {
    this.#entries = new Map(children.map((child) => [child.definition, { kind: child.declaration.kind, value: new Initializer(() => create(child)), checkpoint: child.declaration.checkpoint }]));
    this.#definitions = Object.freeze([...new Set(children.map((child) => child.definition))]);
  }

  definitions(): readonly ChildCallable[] {
    return this.#definitions;
  }

  position(definition: ChildContract): number {
    const position = this.#definitions.findIndex((candidate) => candidate === definition);
    if (position < 0) throw new Error('Child definition is not declared in this binding');
    return position;
  }

  at(position: number): ChildCallable {
    const definition = this.#definitions[position];
    if (!Number.isSafeInteger(position) || !definition) throw new Error('Child declaration position is not registered');
    return definition;
  }

  /** Durable declaration association is independent of lazy Bound initialization. */
  checkpointLayout() {
    return Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({ kind: entry.kind, binding: entry.checkpoint })));
  }

  get<Definition extends ChildContract>(definition: Definition): StoredChild {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.value.get();
  }

  checkpoint(definition: ChildContract): CheckpointBinding | undefined {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.checkpoint;
  }

  checkUses(definitions: readonly ChildContract[]): void {
    for (const definition of definitions) if (!this.#entries.has(definition)) throw new Error('Declaration uses a child outside its owner');
  }

  initialized(definition: ChildContract): boolean {
    return this.#entries.get(definition)?.value.initialized ?? false;
  }
}
