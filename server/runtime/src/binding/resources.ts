import type { ResourceRequest } from '../resource/offer.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { InvocationFact } from '../observation/facts.js';

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
