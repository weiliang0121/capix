import type { InvocationDefinition } from '../definition/invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationWork } from '../invocation/cycle.js';
import type { BoundChildren } from './children.js';

export function bindInvocationWork<I, O, C extends InvocationContext<I, O>, R extends object>(definition: InvocationDefinition<I, O, C, R>, children: BoundChildren): InvocationWork<C, I, O> {
  return {
    maxRounds: definition.maxRounds,
    execute: (context, invocation) => definition.execute(context, invocation, children.forInvocation(invocation)),
    receive: definition.receive ? (context, result, invocation) => definition.receive!(context, result, invocation, children.forInvocation(invocation)) : undefined,
  };
}
