import type { InvocationDefinition } from '../definition/invocation.js';
import type { ScopeOf } from '../context/scope.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from './children.js';

export function bindInvocationWork<I, O, C extends InvocationContext<I, O>, R extends object>(definition: InvocationDefinition<I, O, ScopeOf<C>, R>, children: BoundChildren): InvocationWork<C, I, O> {
  const views = new WeakMap<object, ReturnType<BoundChildren['forInvocation']>>();
  const access = (invocation: Parameters<InvocationWork<C, I, O>['execute']>[1]) => {
    let value = views.get(invocation);
    if (!value) {
      value = children.forInvocation(invocation);
      views.set(invocation, value);
    }
    return value;
  };
  return {
    maxRounds: definition.maxRounds,
    execute: (context, invocation) => definition.execute(invocation.view.context, invocation.view, access(invocation)),
    receive: definition.receive ? (context, result, invocation) => definition.receive!(invocation.view.context, result, invocation.view, access(invocation)) : undefined,
  };
}
