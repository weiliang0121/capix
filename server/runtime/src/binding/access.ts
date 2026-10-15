import { invocationContextView, type ContextViewOf } from '../context/view.js';
import type { InvocationContext } from '../context/context.js';
import type { ChildDefinition } from '../definition/children.js';
import type { Invocation } from '../invocation/invocation.js';
import type { InvocationTarget } from '../invocation/relation.js';
import { invocationView, invocationWorkView, type InvocationView, type InvocationWorkView } from '../invocation/view.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindingsBuilder } from './children/builder.js';
import type { ChildBindings } from './children/contract.js';

type WorkPhase = 'run' | `checkpoint:${string}`;
type AccessPhase = WorkPhase | 'receive' | 'exceptions';
interface PhaseAccess<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly view: InvocationView<Input, Output, ContextViewOf<Context>>;
  readonly children: ChildBindings;
}
interface WorkAccess<Input, Output, Context extends InvocationContext<Input, Output>> extends PhaseAccess<Input, Output, Context> {
  readonly view: InvocationWorkView<Input, Output, ContextViewOf<Context>, any>;
}

/** One invocation's declaration access: child handles span phases; views belong to a phase and round. */
export class InvocationAccess<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly #calls = new Map<InvocationView, InvocationTarget>();
  readonly #phases = new Map<string, PhaseAccess<Input, Output, Context>>();
  readonly #resources: ResourceBindings;

  constructor(
    private readonly invocation: Invocation<Input, Output, Context>,
    private readonly childBindingsBuilder: ChildBindingsBuilder,
  ) {
    this.#resources = (invocation.context as Context & { resources: ResourceBindings }).resources;
  }

  enter(phase: WorkPhase, requires: ResourceRequirements, uses?: readonly ChildDefinition[]): WorkAccess<Input, Output, Context>;
  enter(phase: 'receive' | 'exceptions', requires: ResourceRequirements, uses?: readonly ChildDefinition[]): PhaseAccess<Input, Output, Context>;
  enter(phase: AccessPhase, requires: ResourceRequirements, uses?: readonly ChildDefinition[]): PhaseAccess<Input, Output, Context> {
    const resourcePhase = phase === 'exceptions' ? 'exceptions' : 'run';
    // Phase changes still activate resources when a view is already cached.
    this.#resources.activate(resourcePhase, requires);
    const round = this.invocation.context.progress.round;
    const key = `${phase}:${round}`;
    const existing = this.#phases.get(key);
    if (existing) return existing;

    const context = invocationContextView(this.invocation.context, this.#resources.view(requires, resourcePhase));
    const view = phase === 'run' || phase.startsWith('checkpoint:') ? invocationWorkView(this.invocation.view, context, { output: this.invocation.outputWriter, checkpoint: this.invocation.checkpointWriter }) : invocationView(this.invocation.view, context);
    const children = this.childBindingsBuilder.build(this.invocation, { view, uses, validate: () => this.validate(phase, round), calls: this.#calls });
    const access = { view, children };
    this.#phases.set(key, access);
    return access;
  }

  private validate(phase: AccessPhase, round: number): void {
    if (this.invocation.context.progress.round !== round) throw new Error('Child access belongs to an inactive declaration round');
    const current = this.invocation.context.progress.phase;
    if (phase === 'exceptions' ? current !== 'handling' : current === 'handling') throw new Error('Child access belongs to an inactive declaration phase');
  }
}
