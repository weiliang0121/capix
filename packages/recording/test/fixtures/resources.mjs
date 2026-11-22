import { InvocationResources } from '@weiliang0121/capix-invocation';
import { ResourceSupply } from '@weiliang0121/capix-resources';

export { InvocationResources as ResourceBindings };

export function bindResources(deps, providers) {
  return (source) => new InvocationResources(deps, ResourceSupply.capture(providers, source).entries);
}
