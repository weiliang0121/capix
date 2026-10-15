import type { InvocationDefinition } from '../definition/invocation.js';
import { invocationContextView, type ContextViewOf } from '../context/view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { Invocation } from '../invocation/invocation.js';
import type { BoundChildren } from './children/bound.js';
import type { ChildBindings } from './children/contract.js';
import { ChildBindingsBuilder } from './children/builder.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { InvocationView, InvocationWorkView } from '../invocation/view.js';
import type { InvocationTarget } from '../invocation/relation.js';
import type { ChildDefinition } from '../definition/children.js';

/** One assembly, separate views for work and exception declarations. */
export function bindInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>, Resources extends object, ExceptionResources extends object>(definition: InvocationDefinition<Input, Output, ContextViewOf<Context>, Resources, ExceptionResources, any>, children: BoundChildren): InvocationWork<Input, Output, Context> {
  const access = bindInvocationAccess<Input, Output, Context>(children);
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
                execute: (_context: Context, invocation: Invocation<Input, Output, Context>, state: unknown) => {
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

/** One call registry spans phases; resource/child views stay local to each declaration phase and round. */
function bindInvocationAccess<Input, Output, Context extends InvocationContext<Input, Output>>(children: BoundChildren) {
  const childBindingsBuilder = new ChildBindingsBuilder(children);
  type PhaseBinding = { view: InvocationView<Input, Output, ContextViewOf<Context>>; children: ChildBindings };
  const bindings = new WeakMap<Invocation<Input, Output, Context>, { calls: Map<InvocationView, InvocationTarget>; phases: Map<string, PhaseBinding> }>();
  return (invocation: Invocation<Input, Output, Context>, phase: 'run' | 'receive' | 'exceptions' | `checkpoint:${string}`, requires: ResourceRequirements, uses?: readonly ChildDefinition[]) => {
    const resources = (invocation.context as Context & { resources: ResourceBindings }).resources;
    const resourcePhase = phase === 'exceptions' ? 'exceptions' : 'run';
    resources.activate(resourcePhase, requires);
    let callBindings = bindings.get(invocation);
    if (!callBindings) {
      callBindings = { calls: new Map(), phases: new Map() };
      bindings.set(invocation, callBindings);
    }
    const round = invocation.context.progress.round;
    const key = `${phase}:${round}`;
    let binding = callBindings.phases.get(key);
    if (!binding) {
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
      const childBindings = childBindingsBuilder.build(invocation, { view, uses, validate, calls: callBindings.calls });
      binding = { view, children: childBindings };
      callBindings.phases.set(key, binding);
    }
    return binding;
  };
}
