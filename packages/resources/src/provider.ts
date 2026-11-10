import type { ResourceEndpointActivity } from './endpoint.js';
import type { ResourceIdentity, ResourceRequest } from './request.js';

/** The fixed access definition issued by an offer; supply entries retain this exact token. */
export interface ResourceEndpointDefinition extends ResourceIdentity {
  readonly timing: 'binding' | 'access';
  createEndpoint(material: unknown, activity: ResourceEndpointActivity): unknown;
  describe(material: unknown): unknown;
}

/** Assembly selects a material source. The offer still owns capture and endpoint construction. */
export interface ResourceProvider<Source> {
  readonly offer: ResourceEndpointDefinition;
  readMaterial(source: Source): unknown;
}

export function checkResourceProviders<Source>(requested: readonly ResourceRequest<unknown>[], providers: readonly ResourceProvider<Source>[]): void {
  for (const request of requested) {
    const matches = providers.filter((provider) => provider.offer === request.offer);
    if (matches.length !== 1) throw new Error(`Expected one resource provider for ${request.offer.name}, received ${matches.length}`);
  }
}
