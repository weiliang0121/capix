import type { InvocationScope } from '../context/scope.js';
import type { InvocationView } from '../invocation/view.js';
import type { Continuation, InvocationResult } from '../invocation/result.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';

/** Content contract only: no runtime identity, builders, or live call state. */
export abstract class InvocationDefinition<I, O, C extends InvocationScope<I, O>, R extends object> {
  readonly requires: ResourceRequirements<R> = Object.freeze({}) as ResourceRequirements<R>;
  readonly maxRounds: 1 | 2 = 1;
  abstract execute(context: C, invocation: InvocationView<I, O, C>, children: ChildBindings): O | Promise<O>;
  receive?(context: C, result: InvocationResult<O>, invocation: InvocationView<I, O, C>, children: ChildBindings): O | Continuation<I> | Promise<O | Continuation<I>>;
}
