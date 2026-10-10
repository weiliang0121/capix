import type { InvocationContextView, ContextViewResources } from '../context/view.js';
import type { InvocationView } from '../invocation/view.js';
import type { Continuation, InvocationResolution } from '../invocation/result.js';
import type { ResourceRequest } from '../resource/offer.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { resourceRequests } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';
import type { ChildDefinition } from './children.js';
import type { ExceptionContract, DeclaredException } from '../exception/contract.js';
import type { ObservationDeclaration } from '../observation/definition.js';
import type { InvocationFact } from '../observation/facts.js';

export interface InvocationRunDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object> {
  readonly requires: ResourceRequirements<Resources>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly ChildDefinition[];
  execute(context: ContextView, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): Output | Promise<Output>;
  accept?(context: ContextView, output: Output, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): Output | Continuation<Input> | Promise<Output | Continuation<Input>>;
}

export interface InvocationExceptionDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object> {
  readonly requires: ResourceRequirements<Resources>;
  /** An exception handler receives no child call capabilities unless explicitly declared. */
  readonly uses?: readonly ChildDefinition[];
  readonly accepts: readonly ExceptionContract<any>[];
  handle(context: ContextView, exception: DeclaredException, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): InvocationResolution<Input, Output> | Promise<InvocationResolution<Input, Output>>;
}

/** Owner declaration: work, handling and description are peers; none owns the others. */
export abstract class InvocationDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object, ExceptionResources extends object = Record<string, never>> {
  readonly maxRounds: 1 | 2 = 1;
  readonly raises: readonly ExceptionContract<any>[] = [];
  abstract readonly run: InvocationRunDefinition<Input, Output, ContextView, Resources>;
  readonly exceptions?: InvocationExceptionDefinition<Input, Output, ContextViewResources<ContextView, ExceptionResources>, ExceptionResources>;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
}

/** Supply coverage is shared internally, while each declaration receives only its own named view. */
export function definitionResources(definition: { readonly run: { readonly requires: ResourceRequirements }; readonly exceptions?: { readonly requires: ResourceRequirements }; readonly observation?: readonly ObservationDeclaration<InvocationFact>[] }, localObservationResources?: ResourceRequirements): ResourceRequirements {
  const requires: Record<string, ResourceRequest<unknown>> = {};
  const localOffers = new Set(resourceRequests(localObservationResources ?? {}).map((request) => request.offer));
  for (const [name, request] of Object.entries(definition.run.requires)) requires[`run.${name}`] = request;
  for (const [name, request] of Object.entries(definition.exceptions?.requires ?? {})) requires[`exceptions.${name}`] = request;
  for (const [index, declaration] of (localObservationResources ? (definition.observation ?? []) : []).entries()) {
    for (const [name, request] of Object.entries(declaration.requires)) {
      if (!localOffers.has(request.offer)) requires[`observation.${index}.${name}`] = request;
    }
  }
  return Object.freeze(requires);
}

/** Installed observation supply is excluded only from observation's external requirements. */
export function observationResources(installations?: readonly { readonly provides?: ResourceRequirements }[]): ResourceRequirements | undefined {
  if (!installations) return undefined;
  const provided: Record<string, ResourceRequest<unknown>> = {};
  for (const [index, installation] of installations.entries()) {
    for (const [name, request] of Object.entries(installation.provides ?? {})) provided[`${index}.${name}`] = request;
  }
  return Object.freeze(provided);
}
