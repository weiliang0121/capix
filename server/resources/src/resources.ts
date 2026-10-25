import { ResourceBinding } from './binding.js';
import { ResourceOffer } from './offer.js';
import type { ResourceProvider } from './provider.js';
import { Resource } from './resource.js';
import type { ResourceRequirements } from './request.js';

/** A registry of entities and access offers, independent of callable structures. */
export class Resources {
  readonly #providers: ResourceProvider<unknown>[] = [];

  register<Source, Value, Captured, Selection>(resource: Resource<NoInfer<Source>>, offer: ResourceOffer<Source, Value, Captured, Selection>): this {
    if (!(resource instanceof Resource)) throw new TypeError('Resource registration requires a Resource');
    if (!(offer instanceof ResourceOffer)) throw new TypeError('Resource registration requires an access offer');
    const provider = offer.provide<unknown>(() => resource.origin);
    if (this.#providers.some((entry) => entry.offer === provider.offer)) throw new Error(`Duplicate resource registration: ${provider.offer.name}`);
    this.#providers.push(provider);
    return this;
  }

  bind<Values extends object>(deps: ResourceRequirements<Values>): ResourceBinding<Values> {
    return ResourceBinding.fromProviders(deps, this.#providers, undefined);
  }
}
