import { isResourceRefinement, type ResourceRequest, type ResourceRefinement } from '../resource/offer.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ChildDefinition, DefinitionInvocationInput } from '../definition/children.js';

type RefinableDefinition = Exclude<ChildDefinition, { readonly level: 'execution' }>;

/** Declaration identity locates a trusted assembly rule; content never receives this binding. */
export interface ChildResourceBinding {
  readonly definition: RefinableDefinition;
  readonly refinements: readonly ResourceRefinement<any>[];
}

export function bindChildResources<Definition extends RefinableDefinition>(definition: Definition, refinements: readonly ResourceRefinement<NoInfer<DefinitionInvocationInput<Definition>>>[]): ChildResourceBinding {
  const offers = new Set<ResourceRequest<unknown>['offer']>();
  for (const refinement of refinements) {
    if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
    if (offers.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
    offers.add(refinement.offer);
  }
  return Object.freeze({ definition, refinements: Object.freeze([...refinements]) });
}

export function checkChildResourceBindings(definitions: readonly ChildDefinition[], bindings: readonly ChildResourceBinding[], localObservationResources?: ResourceRequirements): void {
  if (!bindings.length) return;
  const declared = new Set<ChildDefinition>();
  const visit = (children: readonly ChildDefinition[]) => {
    for (const definition of children) {
      if (declared.has(definition)) continue;
      declared.add(definition);
      if (definition.level !== 'attempt') visit(definition.children);
    }
  };
  visit(definitions);
  const bound = new Set<ChildDefinition>();
  for (const binding of bindings) {
    if (!declared.has(binding.definition) || (binding.definition.level !== 'operation' && binding.definition.level !== 'attempt')) throw new Error('Resource refinement requires a declared operation or attempt');
    if (bound.has(binding.definition)) throw new Error('Duplicate child resource binding');
    bound.add(binding.definition);
    const offers = new Set(resourceRequests(definitionResources(binding.definition, localObservationResources)).map((request) => request.offer));
    const refined = new Set<ResourceRequest<unknown>['offer']>();
    for (const refinement of binding.refinements) {
      if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
      if (!offers.has(refinement.offer)) throw new Error(`Refined resource is not requested: ${refinement.offer.name}`);
      if (refined.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
      refined.add(refinement.offer);
    }
  }
}

/** Supply coverage is shared internally, while each declaration receives only its own named view. */
export function definitionResources(definition: { readonly run: { readonly requires: ResourceRequirements }; readonly exceptions?: { readonly requires: ResourceRequirements }; readonly observation?: readonly ObservationDeclaration<InvocationFact>[]; readonly checkpoint?: { readonly points: Readonly<Record<string, { readonly resume: { readonly requires: ResourceRequirements } }>> } }, localObservationResources?: ResourceRequirements): ResourceRequirements {
  const requires: Record<string, ResourceRequest<unknown>> = {};
  const localOffers = new Set(resourceRequests(localObservationResources ?? {}).map((request) => request.offer));
  for (const [name, request] of Object.entries(definition.run.requires)) requires[`run.${name}`] = request;
  for (const [name, request] of Object.entries(definition.exceptions?.requires ?? {})) requires[`exceptions.${name}`] = request;
  for (const [point, declaration] of Object.entries(definition.checkpoint?.points ?? {})) {
    for (const [name, request] of Object.entries(declaration.resume.requires)) requires[`checkpoint.${point}.${name}`] = request;
  }
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
