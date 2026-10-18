import { isResourceRefinement, type ResourceRequest, type ResourceRefinement } from '../resource/offer.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ChildDefinition, DefinitionInput } from '../definition/children.js';

type RefinableDefinition = Exclude<ChildDefinition, { readonly level: 'execution' }>;

interface ResourceDeclarations {
  readonly run: { readonly requires: ResourceRequirements };
  readonly exceptions?: { readonly requires: ResourceRequirements };
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: { readonly points: readonly { readonly name: string; readonly resume: { readonly requires: ResourceRequirements } }[] };
}

/** Declaration identity locates a trusted assembly rule; content never receives this binding. */
export interface ChildResourceBinding {
  readonly definition: RefinableDefinition;
  readonly refinements: readonly ResourceRefinement<any>[];
}

export function bindChildResources<Definition extends RefinableDefinition>(definition: Definition, refinements: readonly ResourceRefinement<NoInfer<DefinitionInput<Definition>>>[]): ChildResourceBinding {
  const offers = new Set<ResourceRequest<unknown>['offer']>();
  for (const refinement of refinements) {
    if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
    if (offers.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
    offers.add(refinement.offer);
  }
  return Object.freeze({ definition, refinements: Object.freeze([...refinements]) });
}

/**
 * Collect supply requirements across declaration phases; this does not resolve resource values.
 * Undefined observationProvides disables observation requirements; an empty map enables them without local supplies.
 * Installed observation supplies cover only observation requests, never run/exception/checkpoint requests.
 */
export function collectDefinitionRequirements(definition: ResourceDeclarations, observationProvides?: ResourceRequirements): ResourceRequirements {
  const requires: Record<string, ResourceRequest<unknown>> = {};
  const observationOffers = new Set(resourceRequests(observationProvides ?? {}).map((request) => request.offer));
  for (const [name, request] of Object.entries(definition.run.requires)) requires[`run.${name}`] = request;
  for (const [name, request] of Object.entries(definition.exceptions?.requires ?? {})) requires[`exceptions.${name}`] = request;
  for (const point of definition.checkpoint?.points ?? []) {
    for (const [name, request] of Object.entries(point.resume.requires)) requires[`checkpoint.${point.name}.${name}`] = request;
  }
  for (const [index, declaration] of (observationProvides ? (definition.observation ?? []) : []).entries()) {
    for (const [name, request] of Object.entries(declaration.requires)) {
      if (!observationOffers.has(request.offer)) requires[`observation.${index}.${name}`] = request;
    }
  }
  return Object.freeze(requires);
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
