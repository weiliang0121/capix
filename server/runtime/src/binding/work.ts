import type { InvocationCheckpointDefinition, InvocationCheckpointPoint, InvocationDefinition } from '../definition/invocation.js';
import type { ContextViewOf } from '../context/view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationCheckpointWork } from '../checkpoint/work.js';
import type { DeclaredException } from '../exception/contract.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { Invocation } from '../invocation/invocation.js';
import type { BoundChildren } from './children/bound.js';
import { ChildBindingsBuilder } from './children/builder.js';
import { InvocationAccess } from './access.js';

/** Fixed declaration adaptation at one Bound position; each invocation gets its own access state. */
export class InvocationWorkBinding<Input, Output, Context extends InvocationContext<Input, Output>, Resources extends object, ExceptionResources extends object> implements InvocationWork<Input, Output, Context> {
  readonly output: InvocationWork<Input, Output, Context>['output'];
  readonly maxRounds: 1 | 2;
  readonly raises: InvocationWork<Input, Output, Context>['raises'];
  readonly checkpoint?: InvocationCheckpointWork<Input, Output, Context>;
  readonly accept?: InvocationWork<Input, Output, Context>['accept'];
  readonly exceptions?: InvocationWork<Input, Output, Context>['exceptions'];
  readonly #childBindingsBuilder: ChildBindingsBuilder;
  readonly #accesses = new WeakMap<Invocation<Input, Output, Context>, InvocationAccess<Input, Output, Context>>();

  constructor(
    private readonly declaration: InvocationDefinition<Input, Output, ContextViewOf<Context>, Resources, ExceptionResources, any>,
    children: BoundChildren,
  ) {
    this.#childBindingsBuilder = new ChildBindingsBuilder(children);
    this.output = declaration.output;
    this.maxRounds = declaration.maxRounds;
    this.raises = declaration.raises;
    // Absence means reuse the execute result; do not install a default acceptance method.
    this.accept = declaration.run.accept ? this.receive.bind(this) : undefined;
    this.exceptions = declaration.exceptions ? { accepts: declaration.exceptions.accepts, handle: this.handle.bind(this) } : undefined;
    this.checkpoint = declaration.checkpoint ? this.bindCheckpoint(declaration.checkpoint) : undefined;
  }

  execute(_context: Context, invocation: Invocation<Input, Output, Context>) {
    const run = this.declaration.run;
    const access = this.accessFor(invocation).enter('run', run.requires, run.uses);
    return run.execute(access.view.context, access.view, access.children);
  }

  private receive(_context: Context, output: Output, invocation: Invocation<Input, Output, Context>) {
    const run = this.declaration.run;
    const access = this.accessFor(invocation).enter('receive', run.requires, run.uses);
    return run.accept!(access.view.context, output, access.view, access.children);
  }

  private handle(_context: Context, exception: DeclaredException, invocation: Invocation<Input, Output, Context>) {
    const exceptions = this.declaration.exceptions!;
    const access = this.accessFor(invocation).enter('exceptions', exceptions.requires, exceptions.uses ?? []);
    return exceptions.handle(access.view.context as never, exception, access.view as never, access.children);
  }

  private resume(pointName: string, point: InvocationCheckpointPoint<Input, Output, ContextViewOf<Context>, any, any, any>, invocation: Invocation<Input, Output, Context>, state: unknown) {
    const resume = point.resume;
    const access = this.accessFor(invocation).enter(`checkpoint:${pointName}`, resume.requires, resume.uses ?? []);
    return resume.execute(access.view.context as never, access.view as never, access.children, state);
  }

  private accessFor(invocation: Invocation<Input, Output, Context>): InvocationAccess<Input, Output, Context> {
    let access = this.#accesses.get(invocation);
    if (!access) {
      access = new InvocationAccess(invocation, this.#childBindingsBuilder);
      this.#accesses.set(invocation, access);
    }
    return access;
  }

  private bindCheckpoint(checkpoint: InvocationCheckpointDefinition<Input, Output, ContextViewOf<Context>, any>): InvocationCheckpointWork<Input, Output, Context> {
    const points: [string, InvocationCheckpointWork<Input, Output, Context>['points'][string]][] = [];
    for (const [name, point] of Object.entries(checkpoint.points)) {
      const execute = (_context: Context, invocation: Invocation<Input, Output, Context>, state: unknown) => this.resume(name, point, invocation, state);
      points.push([name, { state: point.state, check: point.check, execute }]);
    }
    return { key: checkpoint.key, version: checkpoint.version, input: checkpoint.input, output: checkpoint.output, points: Object.fromEntries(points) };
  }
}
