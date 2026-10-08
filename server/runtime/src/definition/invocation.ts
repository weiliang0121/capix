import type { InvocationContext } from '../context/context.js';
import type { Invocation } from '../invocation/invocation.js';
import type { Continuation, InvocationResult } from '../invocation/result.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';

/** Content contract only: no runtime identity, builders, or live call state. */
export abstract class InvocationDefinition<I, O, C extends InvocationContext<I, O>, R extends object> {
  readonly requires: ResourceRequirements<R> = Object.freeze({}) as ResourceRequirements<R>;
  readonly maxRounds: 1 | 2 = 1;
  abstract execute(context: C, invocation: Invocation<I, O, C>, children: ChildBindings): O | Promise<O>;
  receive?(context: C, result: InvocationResult<O>, invocation: Invocation<I, O, C>, children: ChildBindings): O | Continuation<I> | Promise<O | Continuation<I>>;
}
