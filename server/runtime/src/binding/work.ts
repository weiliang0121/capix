import type { CallableKind, ChildContract, ChildReference, CheckpointOccurrence, CheckpointSelection, OperationOutcome } from '@capix/contracts';
import type { InvocationCheckpointDefinition, InvocationCheckpointPoint } from '@capix/structure';
import type { CallableContext, InvocationCheckpointWork, InvocationCheckpointSelection, InvocationCheckpointOccurrence, InvocationWork, Invocation } from '@capix/invocation';
import type { CheckpointReferences, CheckpointReference } from '@capix/checkpoint';
import type { BoundChildren } from './children/bound.js';
import { ChildBindingsBuilder } from './children/builder.js';
import { InvocationAccess } from './access.js';
import { type CallableSnapshot, originalCheckpointPoint } from './snapshot.js';
import { savedCheckpointFacts } from './checkpoint.js';
import { BoundReceptions } from './receptions.js';
import { checkpointList } from './checkpoint-list.js';

/** Fixed declaration adaptation at one Bound position; each invocation gets its own access state. */
export class InvocationWorkBinding<Input, Output, Context extends CallableContext<Input, Output>, Resources extends object, Kind extends CallableKind> implements InvocationWork<Input, Output, Context> {
  readonly output: InvocationWork<Input, Output, Context>['output'];
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  readonly #childBindingsBuilder: ChildBindingsBuilder;
  readonly #accesses = new WeakMap<Invocation<Input, Output, Context>, InvocationAccess<Input, Output, Context>>();
  readonly #entries = new WeakMap<Invocation<Input, Output, Context>, ReturnType<InvocationAccess<Input, Output, Context>['enter']>>();
  readonly #selections = new WeakMap<object, { readonly invocation: Invocation<Input, Output, Context>; readonly raw: InvocationCheckpointSelection }>();
  readonly #savedSelections = new WeakMap<readonly ChildReference[], { readonly invocation: Invocation<Input, Output, Context>; readonly references: readonly CheckpointReference[] }>();

  constructor(
    private readonly declaration: CallableSnapshot<Input, Output, Kind, Resources, any>,
    private readonly children: BoundChildren,
    private readonly composite: boolean,
  ) {
    this.#childBindingsBuilder = new ChildBindingsBuilder(children, new BoundReceptions(declaration.checkpoint?.receptions ?? [], children));
    this.output = declaration.output;
    this.checkpoint = declaration.checkpoint ? this.bindCheckpoint(declaration.checkpoint) : undefined;
  }

  execute(_context: Context, invocation: Invocation<Input, Output, Context>) {
    const declaration = this.declaration;
    const access = this.accessFor(invocation).enter('run', declaration.deps);
    this.#entries.set(invocation, access);
    return declaration.run(this.executionWork(invocation, access) as never);
  }

  close(_context: Context, invocation: Invocation<Input, Output, Context>): OperationOutcome<void> {
    const access = this.#entries.get(invocation);
    this.#entries.delete(invocation);
    try {
      access?.close();
      return { status: 'succeeded', value: undefined };
    } catch (failure) {
      return { status: 'failed', failure };
    }
  }

  private resume(point: InvocationCheckpointPoint<Input, Output, Kind, any, any, any, any, any>, invocation: Invocation<Input, Output, Context>, state: unknown, references: CheckpointReferences) {
    const access = this.accessFor(invocation).enter(`checkpoint:${point.name}`, point.resume.deps, point.resume.uses ?? []);
    this.#entries.set(invocation, access);
    const registry = this.accessFor(invocation).references;
    const saved = Object.freeze(
      Object.fromEntries(
        Object.entries(references).map(([name, value]) => {
          if (!Array.isArray(value)) return [name, registry.fromSaved(value as CheckpointReference)];
          const list = checkpointList(
            () => value.length,
            (index) => registry.fromSaved(value[index]!),
            access.validate,
          );
          // The actual restored array is the Invocation's source proof. Do not map,
          // copy or infer this proof from the public list's contents.
          this.#savedSelections.set(list, { invocation, references: value });
          return [name, list];
        }),
      ),
    );
    return point.resume.run({ ...this.executionWork(invocation, access), initialInput: invocation.context.input, round: invocation.context.progress.round, ...(invocation.context.continuation ? { continuation: registry.continuation(invocation.context.continuation) } : {}) } as never, state, saved as import('@capix/structure').SavedReferences<any>);
  }

  private childPort(access: ReturnType<InvocationAccess<Input, Output, Context>['enter']>) {
    // Only composition installs member actions; all calls retain the same relation mechanism.
    return this.composite ? { children: access.children } : {};
  }

  private executionWork(invocation: Invocation<Input, Output, Context>, access: ReturnType<InvocationAccess<Input, Output, Context>['enter']>) {
    const writer = invocation.checkpointWriter;
    const guarded = <Value>(operation: () => Value): Value => {
      try {
        access.validate();
        return operation();
      } catch (error) {
        invocation.reject(error);
        throw error;
      }
    };
    const registry = this.accessFor(invocation).references;
    const checkpoint = writer
      ? Object.freeze(
          Object.assign(
            (options: { readonly point: object; readonly state: unknown; readonly refs?: Readonly<Record<string, ChildReference | readonly ChildReference[] | CheckpointSelection>> }) =>
              guarded(() => {
                const registered = this.declaration.checkpoint?.points.find((candidate) => originalCheckpointPoint(candidate) === originalCheckpointPoint(options.point));
                if (!registered) throw new Error('Checkpoint point is not registered on this declaration');
                const references = Object.fromEntries(
                  Object.entries(options.refs ?? {}).map(([name, value]) => {
                    const selection = value && typeof value === 'object' ? this.#selections.get(value) : undefined;
                    if (selection) {
                      if (selection.invocation !== invocation) throw new Error('Checkpoint selection belongs to another invocation');
                      return [name, selection.raw];
                    }
                    return [name, Array.isArray(value) ? value.map((ref) => registry.encode(ref)) : registry.encode(value as ChildReference)];
                  }),
                );
                writer.save(registered.name, options.state, references);
              }),
            {
              select: <Definition extends ChildContract>(definition: Definition, initial?: readonly ChildReference<Definition>[]): CheckpointSelection<Definition> =>
                guarded(() => {
                  const position = this.children.position(definition);
                  const restored = initial ? this.#savedSelections.get(initial) : undefined;
                  if (restored && restored.invocation !== invocation) throw new Error('Saved checkpoint selection belongs to another invocation');
                  const raw = writer.select(position, restored ? restored.references : initial?.map((ref) => registry.encode(ref)));
                  const selected = Object.freeze({
                    get length() {
                      return guarded(() => raw.length);
                    },
                    at: (index: number) =>
                      guarded(() => {
                        const ref = raw.at(index);
                        return ref ? (registry.fromSaved(ref) as ChildReference<Definition>) : undefined;
                      }),
                    occurrenceAt: (index: number) => guarded(() => raw.occurrenceAt(index) as unknown as CheckpointOccurrence<Definition> | undefined),
                    add: (ref: ChildReference<Definition>) =>
                      guarded(() => {
                        const encoded = registry.encode(ref);
                        if (encoded.target.position !== position) throw new Error('Checkpoint selection child declaration differs');
                        return raw.add(encoded) as unknown as CheckpointOccurrence<Definition>;
                      }),
                    remove: (occurrence: CheckpointOccurrence<Definition>) => guarded(() => raw.remove(occurrence as unknown as InvocationCheckpointOccurrence)),
                    *[Symbol.iterator]() {
                      const iterator = guarded(() => raw[Symbol.iterator]());
                      for (let next = guarded(() => iterator.next()); !next.done; next = guarded(() => iterator.next())) yield guarded(() => registry.fromSaved(next.value) as ChildReference<Definition>);
                    },
                  }) as unknown as CheckpointSelection<Definition>;
                  this.#selections.set(selected, { invocation, raw });
                  return selected;
                }),
            },
          ),
        )
      : undefined;
    const output = this.declaration.output?.delta ? invocation.outputWriter : undefined;
    return Object.freeze({ ...access.base, ...this.childPort(access), ...(checkpoint ? { checkpoint } : {}), ...(output ? { output } : {}) });
  }

  private accessFor(invocation: Invocation<Input, Output, Context>): InvocationAccess<Input, Output, Context> {
    let access = this.#accesses.get(invocation);
    if (!access) {
      access = new InvocationAccess(invocation, this.#childBindingsBuilder);
      this.#accesses.set(invocation, access);
    }
    return access;
  }

  private bindCheckpoint(checkpoint: InvocationCheckpointDefinition<Input, Output, Kind, any>): InvocationCheckpointWork<Input, Output, Context> {
    const points = Object.fromEntries(
      checkpoint.points.map((point) => [
        point.name,
        {
          state: point.state,
          references: Object.fromEntries(
            Object.entries(point.references).map(([name, slot]) => {
              const reference = slot as { definition: import('@capix/structure').ChildContract; many: boolean };
              return [name, { cardinality: reference.many ? ('many' as const) : ('one' as const), position: this.children.position(reference.definition) }];
            }),
          ),
          check: (_frame: unknown, state: unknown, references: CheckpointReferences, decoded: import('@capix/invocation').DecodedCheckpointFrame) => {
            const query = savedCheckpointFacts(decoded, references, this.children, this.#childBindingsBuilder.receptions);
            try {
              return point.check?.(state, query.facts as never);
            } finally {
              query.close();
            }
          },
          execute: (_context: Context, invocation: Invocation<Input, Output, Context>, state: unknown, references: CheckpointReferences) => this.resume(point, invocation, state, references),
        },
      ]),
    );
    return { key: checkpoint.key, version: checkpoint.version, input: checkpoint.input, output: checkpoint.output, children: this.children.checkpointLayout(), receptions: this.#childBindingsBuilder.receptions.bindings(), points };
  }
}
