import type { invocationSignature } from '../definition/signature.js';
import type { CallableKind } from '@capix/protocol';
import type { InvocationCheckpointDefinition, InvocationCheckpointPoint, CallableDefinition } from '../definition/callable.js';
import type { Resolution, Continue } from '../definition/work.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationCheckpointWork } from '../checkpoint/work.js';
import type { CheckpointReferences, CheckpointReference } from '../checkpoint/contract.js';
import type { DeclaredException } from '../exception/contract.js';
import type { InvocationWork } from '../invocation/work.js';
import type { Invocation } from '../invocation/invocation.js';
import { Continuation, type InvocationResolution } from '../invocation/result.js';
import type { ChildReference } from '../definition/children.js';
import type { BoundChildren } from './children/bound.js';
import { ChildBindingsBuilder } from './children/builder.js';
import { InvocationAccess } from './access.js';
import { originalCheckpointPoint } from './snapshot.js';
import { savedCheckpointFacts } from './checkpoint.js';
import { BoundReceptions } from './receptions.js';

/** Private token shape distinguishes a control proposal from ordinary business objects. */
class AcceptanceProposal {
  readonly #token = true;
}

function authorOutput<Output>(value: Output): Output {
  if (value instanceof Continuation || value instanceof AcceptanceProposal) throw new Error('Invocation control must be issued by the current author phase');
  return value;
}

/** Fixed declaration adaptation at one Bound position; each invocation gets its own access state. */
export class InvocationWorkBinding<Input, Output, Context extends InvocationContext<Input, Output>, Resources extends object, ExceptionResources extends object, Kind extends CallableKind> implements InvocationWork<Input, Output, Context> {
  readonly output: InvocationWork<Input, Output, Context>['output'];
  readonly maxRounds: 1 | 2;
  readonly raises: InvocationWork<Input, Output, Context>['raises'];
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  readonly accept?: InvocationWork<Input, Output, Context>['accept'];
  readonly exceptions?: InvocationWork<Input, Output, Context>['exceptions'];
  readonly #childBindingsBuilder: ChildBindingsBuilder;
  readonly #accesses = new WeakMap<Invocation<Input, Output, Context>, InvocationAccess<Input, Output, Context>>();

  constructor(
    private readonly declaration: Omit<CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, any>, typeof invocationSignature> & { readonly kind: Kind },
    private readonly children: BoundChildren,
    private readonly composite: boolean,
  ) {
    this.#childBindingsBuilder = new ChildBindingsBuilder(children, new BoundReceptions(declaration.receptions ?? [], children));
    this.output = declaration.output;
    this.maxRounds = declaration.maxRounds;
    this.raises = declaration.raises;
    this.accept = declaration.run.accept ? this.receive.bind(this) : undefined;
    this.exceptions = declaration.exceptions ? { accepts: declaration.exceptions.accepts, handle: this.handle.bind(this) } : undefined;
    this.checkpoint = declaration.checkpoint ? this.bindCheckpoint(declaration.checkpoint) : undefined;
  }

  async execute(_context: Context, invocation: Invocation<Input, Output, Context>) {
    const run = this.declaration.run;
    const access = this.accessFor(invocation).enter('run', run.requires, run.uses);
    return authorOutput(await run.execute(this.executionWork(invocation, access) as never));
  }

  private async receive(_context: Context, output: Output, invocation: Invocation<Input, Output, Context>) {
    const run = this.declaration.run;
    const access = this.accessFor(invocation).enter('receive', run.requires, run.uses);
    const proposals = new WeakMap<AcceptanceProposal, Continuation<Input>>();
    const work = Object.freeze({
      ...access.base,
      ...this.childPort(access),
      delivered: output,
      continue: (input: Input, reason: string) => {
        access.validate();
        const proposal = new AcceptanceProposal();
        Object.freeze(proposal);
        proposals.set(proposal, new Continuation(input, reason));
        return proposal as unknown as Continue<Input>;
      },
    });
    const result = await run.accept!(work as never);
    if (result instanceof AcceptanceProposal) {
      const continuation = proposals.get(result);
      if (!continuation) throw new Error('Continuation was not issued by this acceptance phase');
      return continuation;
    }
    return authorOutput(result as Output);
  }

  private async handle(_context: Context, exception: DeclaredException, invocation: Invocation<Input, Output, Context>) {
    const exceptions = this.declaration.exceptions!;
    const access = this.accessFor(invocation).enter('exceptions', exceptions.requires, exceptions.uses ?? []);
    const proposals = new WeakMap<Resolution<Input, Output>, InvocationResolution<Input, Output>>();
    const issue = (value: InvocationResolution<Input, Output>): Resolution<Input, Output> => {
      access.validate();
      const proposal = Object.freeze({}) as Resolution<Input, Output>;
      proposals.set(proposal, Object.freeze(value));
      return proposal;
    };
    const origin = invocation.exceptionOrigin;
    if (!origin) throw new Error('Exception handler has no established origin');
    const work = Object.freeze({ ...access.base, ...this.childPort(access), exception, origin: this.accessFor(invocation).references.origin(origin), continue: (input: Input, reason: string) => issue({ kind: 'continue', input, reason }), return: (output: Output) => issue({ kind: 'return', output }), unhandled: issue({ kind: 'unhandled' }) });
    const result = await exceptions.handle(work as never);
    const resolution = result && typeof result === 'object' ? proposals.get(result) : undefined;
    if (!resolution) throw new Error('Exception resolution was not issued by this handling phase');
    if (resolution.kind === 'return') authorOutput(resolution.output);
    return resolution;
  }

  private async resume(point: InvocationCheckpointPoint<Input, Output, Kind, any, any, any, any, any>, invocation: Invocation<Input, Output, Context>, state: unknown, references: CheckpointReferences) {
    const access = this.accessFor(invocation).enter(`checkpoint:${point.name}`, point.resume.requires, point.resume.uses ?? []);
    const registry = this.accessFor(invocation).references;
    const saved = Object.freeze(Object.fromEntries(Object.entries(references).map(([name, value]) => [name, Array.isArray(value) ? Object.freeze(value.map((ref) => registry.fromSaved(ref))) : registry.fromSaved(value as CheckpointReference)])));
    try {
      return authorOutput(await point.resume.execute(this.executionWork(invocation, access) as never, state, saved as import('../definition/checkpoint.js').SavedReferences<any>));
    } finally {
      invocation.sealOutput();
      const settling = invocation.children.settleAcceptances();
      if (settling) await settling;
      access.close();
    }
  }

  private childPort(access: ReturnType<InvocationAccess<Input, Output, Context>['enter']>) {
    // Only composition installs member actions; all calls retain the same relation mechanism.
    return this.composite ? { children: access.children } : {};
  }

  private executionWork(invocation: Invocation<Input, Output, Context>, access: ReturnType<InvocationAccess<Input, Output, Context>['enter']>) {
    const writer = invocation.checkpointWriter;
    const checkpoint = writer
      ? Object.freeze({
          save: (point: object, state: unknown, refs: Readonly<Record<string, ChildReference | readonly ChildReference[]>>) => {
            try {
              access.validate();
              const registered = this.declaration.checkpoint?.points.find((candidate) => originalCheckpointPoint(candidate) === point);
              if (!registered) throw new Error('Checkpoint point is not registered on this declaration');
              const registry = this.accessFor(invocation).references;
              const references = Object.fromEntries(Object.entries(refs).map(([name, value]) => [name, Array.isArray(value) ? value.map((ref) => registry.encode(ref)) : registry.encode(value as ChildReference)]));
              writer.save(registered.name, state, references);
            } catch (error) {
              invocation.reject(error);
              throw error;
            }
          },
        })
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
              const reference = slot as { definition: import('../definition/children.js').ChildContract; many: boolean };
              return [name, { cardinality: reference.many ? ('many' as const) : ('one' as const), position: this.children.position(reference.definition) }];
            }),
          ),
          check: (_frame: unknown, state: unknown, references: CheckpointReferences, decoded: import('../checkpoint/facts.js').DecodedCheckpointFrame) => point.check?.(state, savedCheckpointFacts(decoded, references, this.children, this.#childBindingsBuilder.receptions) as never),
          execute: (_context: Context, invocation: Invocation<Input, Output, Context>, state: unknown, references: CheckpointReferences) => this.resume(point, invocation, state, references),
        },
      ]),
    );
    return { key: checkpoint.key, version: checkpoint.version, input: checkpoint.input, output: checkpoint.output, children: this.children.checkpointLayout(), receptions: this.#childBindingsBuilder.receptions.bindings(), points };
  }
}
