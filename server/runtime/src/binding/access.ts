import type { InvocationContext } from '../context/context.js';
import type { ChildContract } from '../definition/children.js';
import type { Invocation } from '../invocation/invocation.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindingsBuilder } from './children/builder.js';
import type { InvocationChildReferences } from './children/references.js';

export type AccessPhase = 'run' | `checkpoint:${string}`;

/** Single-call facts survive phases; actions and resources are issued for a specific phase/round. */
export class InvocationAccess<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly references: InvocationChildReferences;
  readonly #resources: ResourceBindings;

  constructor(
    private readonly invocation: Invocation<Input, Output, Context>,
    private readonly childBindingsBuilder: ChildBindingsBuilder,
  ) {
    this.#resources = (invocation.context as Context & { resources: ResourceBindings }).resources;
    this.references = childBindingsBuilder.references(invocation);
  }

  enter(phase: AccessPhase, deps: ResourceRequirements, uses?: readonly ChildContract[]) {
    const resourcePhase = phase;
    this.#resources.activate(resourcePhase, deps);
    const context = this.invocation.context;
    const round = context.progress.round;
    let open = true;
    const validate = () => {
      try {
        this.invocation.requireActive();
        if (!open) throw new Error('Work access window is closed');
        if (context.progress.round !== round) throw new Error('Work belongs to an inactive declaration round');
        if (context.progress.phase !== 'execute') throw new Error('Work belongs to an inactive declaration phase');
      } catch (error) {
        this.invocation.reject(error);
        throw error;
      }
    };
    const children = this.childBindingsBuilder.build(this.invocation, { uses, validate, references: this.references, restoring: phase.startsWith('checkpoint:') });
    const base = {
      input: context.currentInput,
      resources: this.#resources.view(deps, resourcePhase),
      signal: (context as Context & { signal: AbortSignal }).signal,
      observation: (event: import('../observation/facts.js').BusinessEvent) => {
        validate();
        this.invocation.observeBusiness(event);
      },
    };
    const close = () => {
      open = false;
      this.#resources.close(resourcePhase);
    };
    return { base: Object.freeze(base), children, validate, close };
  }
}
