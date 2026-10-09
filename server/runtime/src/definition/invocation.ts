import type { InvocationScope, ScopeResources } from '../context/scope.js';
import type { InvocationView } from '../invocation/view.js';
import type { Continuation, InvocationResolution } from '../invocation/result.js';
import type { ResourceRequest } from '../resource/offer.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';
import type { ChildDefinition } from './children.js';
import type { ExceptionContract, DeclaredException } from '../exception/contract.js';
import type { InvocationObservation } from '../invocation/recording.js';

export interface InvocationRunDefinition<I, O, C extends InvocationScope<I, O>, R extends object> {
  readonly requires: ResourceRequirements<R>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly ChildDefinition[];
  execute(context: C, invocation: InvocationView<I, O, C>, children: ChildBindings): O | Promise<O>;
  accept?(context: C, output: O, invocation: InvocationView<I, O, C>, children: ChildBindings): O | Continuation<I> | Promise<O | Continuation<I>>;
}

export interface InvocationExceptionDefinition<I, O, C extends InvocationScope<I, O>, R extends object> {
  readonly requires: ResourceRequirements<R>;
  /** An exception handler receives no child call capabilities unless explicitly declared. */
  readonly uses?: readonly ChildDefinition[];
  readonly accepts: readonly ExceptionContract<any>[];
  handle(context: C, exception: DeclaredException, invocation: InvocationView<I, O, C>, children: ChildBindings): InvocationResolution<I, O> | Promise<InvocationResolution<I, O>>;
}

/** Owner declaration: work, handling and description are peers; none owns the others. */
export abstract class InvocationDefinition<I, O, C extends InvocationScope<I, O>, R extends object, H extends object = Record<string, never>> {
  readonly maxRounds: 1 | 2 = 1;
  readonly raises: readonly ExceptionContract<any>[] = [];
  abstract readonly run: InvocationRunDefinition<I, O, C, R>;
  readonly exceptions?: InvocationExceptionDefinition<I, O, ScopeResources<C, H>, H>;
  readonly observation?: InvocationObservation<I, O>;
}

/** Supply coverage is shared internally, while each declaration receives only its own named view. */
export function definitionResources(definition: { readonly run: { readonly requires: ResourceRequirements }; readonly exceptions?: { readonly requires: ResourceRequirements } }): ResourceRequirements {
  const requires: Record<string, ResourceRequest<unknown>> = {};
  for (const [name, request] of Object.entries(definition.run.requires)) requires[`run.${name}`] = request;
  for (const [name, request] of Object.entries(definition.exceptions?.requires ?? {})) requires[`exceptions.${name}`] = request;
  return Object.freeze(requires);
}
