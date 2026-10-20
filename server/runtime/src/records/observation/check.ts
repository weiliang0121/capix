import type { ObservationDeclarationScope } from '../../definition/observation.js';
import type { ResourceIdentity } from '../../resource/offer.js';
import { resourceRequests } from '../../resource/bindings.js';

/** Configured gaps are rejected before execution; runtime observer failure has a separate policy. */
export function checkRecordingDeclaration(definition: ObservationDeclarationScope, parent: ObservationDeclarationScope | undefined, writer: ResourceIdentity): void {
  const requestsWriter = (scope: ObservationDeclarationScope) => scope.observation?.some((declaration) => resourceRequests(declaration.requires).some((request) => request.offer === writer)) ?? false;
  if (requestsWriter(definition) && parent && !requestsWriter(parent)) throw new Error('Call recording requires a recording declaration on its direct parent');
}
