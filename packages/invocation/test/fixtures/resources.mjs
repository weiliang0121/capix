import { InvocationResources } from '@weiliang0121/capix-invocation';
import { ResourceSupply, checkResourceProviders, resourceRequests } from '@weiliang0121/capix-resources';

// Historical setup vocabulary remains only in test fixtures. Production uses explicit binding/access.
export { InvocationResources as ResourceBindings };
export function bindResources(deps, providers) {
  const fixed = Object.freeze({ ...deps });
  const requests = resourceRequests(fixed);
  checkResourceProviders(requests, providers);
  const offers = new Set(requests.map((request) => request.offer));
  const selected = providers.filter((provider) => offers.has(provider.offer));
  return (source) => new InvocationResources(fixed, ResourceSupply.capture(selected, source).entries);
}
