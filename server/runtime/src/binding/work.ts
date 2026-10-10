import type { InvocationDefinition } from '../definition/invocation.js';
import { invocationContextView, type ContextViewOf } from '../context/view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from './children.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { InvocationView } from '../invocation/view.js';
import type { ChildDefinition } from '../definition/children.js';

/** One assembly, separate views for work and exception declarations. */
export function bindInvocationWork<Input, Output, Context extends InvocationContext<Input, Output>, Resources extends object, ExceptionResources extends object>(definition: InvocationDefinition<Input, Output, ContextViewOf<Context>, Resources, ExceptionResources>, children: BoundChildren): InvocationWork<Input, Output, Context> {
  type Call = Parameters<InvocationWork<Input, Output, Context>['execute']>[1];
  const phases = new WeakMap<Call, Map<string, { view: InvocationView<Input, Output, ContextViewOf<Context>>; children: ReturnType<BoundChildren['forInvocation']> }>>();
  const access = (invocation: Call, phase: 'run' | 'exceptions', requires: ResourceRequirements, uses?: readonly ChildDefinition[]) => {
    const resources = (invocation.context as Context & { resources: ResourceBindings }).resources;
    resources.activate(phase, requires);
    let calls = phases.get(invocation);
    if (!calls) {
      calls = new Map();
      phases.set(invocation, calls);
    }
    let value = calls.get(phase);
    if (!value) {
      const context = invocationContextView(invocation.context, resources.view(requires, phase));
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
      });
      const validate = () => {
        const current = invocation.context.progress.phase;
        if (phase === 'exceptions' ? current !== 'handling' : current === 'handling') throw new Error('Child access belongs to an inactive declaration phase');
      };
      value = { view, children: children.forInvocation(invocation, view, uses, validate) };
      calls.set(phase, value);
    }
    return value;
  };
  const run = definition.run;
  const exceptions = definition.exceptions;
  children.checkUses(run.uses ?? []);
  children.checkUses(exceptions?.uses ?? []);
  return {
    maxRounds: definition.maxRounds,
    raises: definition.raises,
    execute: (_context, invocation) => {
      const bound = access(invocation, 'run', run.requires, run.uses);
      return run.execute(bound.view.context, bound.view, bound.children);
    },
    accept: run.accept
      ? (_context, output, invocation) => {
          const bound = access(invocation, 'run', run.requires, run.uses);
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
