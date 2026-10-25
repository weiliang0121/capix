import { callableDependencies, type CallableDependencies } from '@capix/structure/construction';
import { isResourceRefinement, type ResourceRequest, type ResourceRefinement, resourceRequests, type ResourceRequirements } from '@capix/resources';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ChildCallable } from '@capix/structure';
import type { CallableInput } from '@capix/contracts';

type RefinableDefinition = ChildCallable;

/** Declaration identity locates a trusted assembly rule; content never receives this binding. */
export interface ChildResourceBinding {
  readonly definition: RefinableDefinition;
  readonly refinements: readonly ResourceRefinement<any>[];
}

export function bindChildResources<Definition extends RefinableDefinition>(definition: Definition, refinements: readonly ResourceRefinement<NoInfer<CallableInput<Definition>>>[]): ChildResourceBinding {
  const offers = new Set<ResourceRequest<unknown>['offer']>();
  for (const refinement of refinements) {
    if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
    if (offers.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
    offers.add(refinement.offer);
  }
  return Object.freeze({ definition, refinements: Object.freeze([...refinements]) });
}

/**
 * Collect this declaration's requirements across phases; this does not resolve resource values.
 * Undefined observationProvides disables observation requirements; an empty map enables them without local supplies.
 * Installed observation supplies cover only observation requests, never run/checkpoint requests.
 */
export function collectDefinitionRequirements(definition: CallableDependencies, observationProvides?: ResourceRequirements, observations: readonly ObservationDeclaration<InvocationFact>[] = []): ResourceRequirements {
  const deps: Record<string, ResourceRequest<unknown>> = { ...callableDependencies(definition) };
  const observationOffers = new Set(resourceRequests(observationProvides ?? {}).map((request) => request.offer));
  for (const [index, declaration] of (observationProvides ? observations : []).entries()) {
    for (const [name, request] of Object.entries(declaration.deps)) {
      if (!observationOffers.has(request.offer)) deps[`observation.${index}.${name}`] = request;
    }
  }
  return Object.freeze(deps);
}

/** Internal supply routing retains offer identities, independently of each phase's local aliases. */
export function collectResourceSupply(requirements: readonly ResourceRequirements[]): ResourceRequirements {
  const supply: Record<string, ResourceRequest<unknown>> = {};
  const offers = new Set<ResourceRequest<unknown>['offer']>();
  for (const deps of requirements) {
    for (const request of resourceRequests(deps)) {
      if (offers.has(request.offer)) continue;
      offers.add(request.offer);
      supply[`supply.${offers.size - 1}`] = request;
    }
  }
  return Object.freeze(supply);
}

/** Collect installed observation offers; preserve undefined (disabled) versus an empty enabled installation. */
export function collectObservationProvides(installations?: readonly { readonly provides?: ResourceRequirements }[]): ResourceRequirements | undefined {
  if (!installations) return undefined;
  const provided: Record<string, ResourceRequest<unknown>> = {};
  for (const [index, installation] of installations.entries()) {
    for (const [name, request] of Object.entries(installation.provides ?? {})) provided[`${index}.${name}`] = request;
  }
  return Object.freeze(provided);
}
