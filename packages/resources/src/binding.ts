import { ResourceAccess, type ResourceAccessHooks } from './access.js';
import type { ResourceOwner } from './ports.js';
import { checkResourceProviders, type ResourceProvider } from './provider.js';
import { resourceRequests, type ResourceRequirements } from './request.js';
import { ResourceSupply } from './supply.js';

/** Fixed dependency wiring. Opening creates access; it never looks up a mutable registry. */
export class ResourceBinding<Resources extends object = object> {
  readonly #deps: ResourceRequirements<Resources>;

  private constructor(
    deps: ResourceRequirements<Resources>,
    private readonly supply: () => ResourceSupply,
  ) {
    this.#deps = Object.freeze({ ...deps });
    Object.freeze(this);
  }

  /** Existing invocation materials may be shared by distinct, revocable phase windows. */
  static fromSupply<Resources extends object>(deps: ResourceRequirements<Resources>, supply: ResourceSupply): ResourceBinding<Resources> {
    const requests = Object.freeze({ ...deps });
    const selected = supply.select(requests);
    return new ResourceBinding(requests, () => selected);
  }

  /** Registrations are fixed now; each independent access receives fresh material captures. */
  static fromProviders<Source, Resources extends object>(deps: ResourceRequirements<Resources>, providers: readonly ResourceProvider<Source>[], source: Source): ResourceBinding<Resources> {
    const dependencies = Object.freeze({ ...deps });
    const requests = resourceRequests(dependencies);
    checkResourceProviders(requests, providers);
    const offers = new Set(requests.map((request) => request.offer));
    const selected = providers.filter((provider) => offers.has(provider.offer)).map((provider) => Object.freeze({ offer: provider.offer, readMaterial: provider.readMaterial.bind(provider) }));
    return new ResourceBinding(dependencies, () => ResourceSupply.capture(selected, source));
  }

  open(owner?: ResourceOwner, hooks?: ResourceAccessHooks): ResourceAccess<Resources> {
    const access = new ResourceAccess(this.#deps, this.supply, owner, hooks);
    try {
      access.start();
      return access;
    } catch (error) {
      access.close();
      throw error;
    }
  }
}
