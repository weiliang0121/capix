import type { ResourceRequirements, ResourceRequest } from '@capix/resources';

export interface CallableDependencies {
  readonly deps?: ResourceRequirements;
  readonly checkpoint?: { readonly points: readonly { readonly name: string; readonly resume: { readonly deps: ResourceRequirements } }[] };
}

/** Read declared requirements only. This neither resolves supply nor opens access. */
export function callableDependencies(definition: CallableDependencies): ResourceRequirements {
  const deps: Record<string, ResourceRequest<unknown>> = {};
  for (const [name, request] of Object.entries(definition.deps ?? {})) deps[`run.${name}`] = request;
  for (const point of definition.checkpoint?.points ?? []) {
    for (const [name, request] of Object.entries(point.resume.deps)) deps[`checkpoint.${point.name}.${name}`] = request;
  }
  return Object.freeze(deps);
}
