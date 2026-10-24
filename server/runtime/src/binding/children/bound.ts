import type { ChildContract, ChildCallable } from '../../definition/children.js';
import type { CheckpointBinding } from '../../checkpoint/work.js';
import type { NamedMembers } from '../../definition/composition.js';
import { checkMemberName } from '../../structure/members.js';
import type { ResolvedChild } from '../declarations.js';

/** Reusable child structures; no parent invocation or phase access is retained here. */
export class BoundChildren {
  readonly #entries: ReadonlyMap<ChildContract, { readonly kind: ChildCallable['kind']; readonly value: ChildCallable; readonly checkpoint?: CheckpointBinding }>;
  readonly #definitions: readonly ChildCallable[];
  readonly #names: ReadonlyMap<string, ChildContract>;

  constructor(children: readonly ResolvedChild[], names: NamedMembers = {}) {
    this.#entries = new Map(children.map((child) => [child.definition, { kind: child.declaration.kind, value: child.definition, checkpoint: child.declaration.checkpoint }]));
    this.#definitions = Object.freeze([...new Set(children.map((child) => child.definition))]);
    for (const [name, definition] of Object.entries(names)) {
      checkMemberName(name);
      if (!this.#entries.has(definition)) throw new Error('Named member is outside its owner');
    }
    this.#names = new Map(Object.entries(names));
  }

  names(): ReadonlyMap<string, ChildContract> {
    return this.#names;
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

  /** Durable member positions do not require constructing a child invocation. */
  checkpointLayout() {
    return Object.freeze([...this.#entries.values()].map((entry) => Object.freeze({ kind: entry.kind, binding: entry.checkpoint })));
  }

  get<Definition extends ChildContract>(definition: Definition): ChildCallable {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.value;
  }

  checkpoint(definition: ChildContract): CheckpointBinding | undefined {
    const entry = this.#entries.get(definition);
    if (!entry) throw new Error('Child definition is not declared in this binding');
    return entry.checkpoint;
  }

  checkUses(definitions: readonly ChildContract[]): void {
    for (const definition of definitions) if (!this.#entries.has(definition)) throw new Error('Declaration uses a child outside its owner');
  }
}
