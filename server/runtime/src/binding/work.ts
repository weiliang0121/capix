import type { InvocationDefinition } from '../definition/invocation.js';
import { invocationContextView, type ContextViewOf } from '../context/view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from './children/bound.js';
import type { ChildBindings } from './children/contract.js';
import { ChildBindingsBuilder } from './children/builder.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { InvocationView, InvocationWorkView } from '../invocation/view.js';
import type { InvocationTarget } from '../invocation/relation.js';
import type { ChildDefinition } from '../definition/children.js';

/** One assembly, separate views for work and exception declarations. */
export function bindInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>, Resources extends object, ExceptionResources extends object>(definition: InvocationDefinition<Input, Output, ContextViewOf<Context>, Resources, ExceptionResources, any>, children: BoundChildren): InvocationWork<Input, Output, Context> {
  type Call = Parameters<InvocationWork<Input, Output, Context>['execute']>[1];
  const childBindingsBuilder = new ChildBindingsBuilder(children);
  // Call identity is shared across phases; access constraints belong to each phase and round.
  const registries = new WeakMap<Call, Map<InvocationView, InvocationTarget>>();
  const phases = new WeakMap<Call, Map<string, { view: InvocationView<Input, Output, ContextViewOf<Context>>; children: ChildBindings }>>();
  const access = (invocation: Call, phase: 'run' | 'receive' | 'exceptions' | `checkpoint:${string}`, requires: ResourceRequirements, uses?: readonly ChildDefinition[]) => {
    const resources = (invocation.context as Context & { resources: ResourceBindings }).resources;
    const resourcePhase = phase === 'exceptions' ? 'exceptions' : 'run';
    resources.activate(resourcePhase, requires);
    let registry = registries.get(invocation);
    if (!registry) {
      registry = new Map();
      registries.set(invocation, registry);
    }
    let phaseBindings = phases.get(invocation);
    if (!phaseBindings) {
      phaseBindings = new Map();
      phases.set(invocation, phaseBindings);
    }
    const round = invocation.context.progress.round;
    const key = `${phase}:${round}`;
    let value = phaseBindings.get(key);
    if (!value) {
      const context = invocationContextView(invocation.context, resources.view(requires, resourcePhase));
      const view = Object.freeze({
        context,
        origin: invocation.view.origin,
        get failure() {
          return invocation.view.failure;
        },
        get sequence() {
          return invocation.view.sequence;
        },
        children: invocation.view.children,
        ...(phase === 'run' || phase.startsWith('checkpoint:') ? { output: invocation.outputWriter, checkpoint: invocation.checkpointWriter } : {}),
      });
      const validate = () => {
        if (invocation.context.progress.round !== round) throw new Error('Child access belongs to an inactive declaration round');
        const current = invocation.context.progress.phase;
        if (phase === 'exceptions' ? current !== 'handling' : current === 'handling') throw new Error('Child access belongs to an inactive declaration phase');
      };
      const childBindings = childBindingsBuilder.build(invocation, { view, uses, validate, calls: registry });
      value = { view, children: childBindings };
      phaseBindings.set(key, value);
    }
    return value;
  };
  const run = definition.run;
  const exceptions = definition.exceptions;
  children.checkUses(run.uses ?? []);
  children.checkUses(exceptions?.uses ?? []);
  for (const point of Object.values(definition.checkpoint?.points ?? {})) children.checkUses(point.resume.uses ?? []);
  return {
    output: definition.output,
    maxRounds: definition.maxRounds,
    raises: definition.raises,
    checkpoint: definition.checkpoint
      ? {
          key: definition.checkpoint.key,
          version: definition.checkpoint.version,
          input: definition.checkpoint.input,
          output: definition.checkpoint.output,
          points: Object.fromEntries(
            Object.entries(definition.checkpoint.points).map(([name, point]) => [
              name,
              {
                state: point.state,
                check: point.check,
                execute: (_context: Context, invocation: Call, state: unknown) => {
                  const bound = access(invocation, `checkpoint:${name}`, point.resume.requires, point.resume.uses ?? []);
                  return point.resume.execute(bound.view.context as never, bound.view as never, bound.children, state);
                },
              },
            ]),
          ),
        }
      : undefined,
    execute: (_context, invocation) => {
      const bound = access(invocation, 'run', run.requires, run.uses);
      return run.execute(bound.view.context, bound.view as InvocationWorkView<Input, Output, ContextViewOf<Context>, any>, bound.children);
    },
    accept: run.accept
      ? (_context, output, invocation) => {
          const bound = access(invocation, 'receive', run.requires, run.uses);
          return run.accept!(bound.view.context, output, bound.view, bound.children);
        }
      : undefined,
    exceptions: exceptions
      ? {
          accepts: exceptions.accepts,
          handle: (_context, exception, invocation) => {
            const bound = access(invocation, 'exceptions', exceptions.requires, exceptions.uses ?? []);
            return exceptions.handle(bound.view.context as never, exception, bound.view as never, bound.children);
          },
        }
      : undefined,
  };
}
