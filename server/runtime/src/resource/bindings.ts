import { Initializer } from '../initialization/initializer.js';
import { type ResourceRequest, type ResourceProvider, type ResourceValue } from './offer.js';

export type ResourceRequirements<R extends object = object> = { readonly [K in keyof R]: ResourceRequest<R[K]> };

export function resourceRequests<R extends object>(requires: ResourceRequirements<R>): readonly ResourceRequest<unknown>[] {
  return Object.keys(requires).map((name) => requires[name as keyof R]);
}

/** Keeps fulfilled offer identities with their values, so child requests cannot match by alias alone. */
export class ResourceBindings<R extends object = object> {
  readonly values: Readonly<R>;
  readonly #entries: readonly ResourceValue[];

  constructor(requires: ResourceRequirements<R>, available: readonly ResourceValue[] = []) {
    const entries: ResourceValue[] = [];
    const values = {};
    for (const name of Object.keys(requires)) {
      const request = requires[name as keyof R];
      const entry = available.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      entries.push(entry);
      Object.defineProperty(values, name, { enumerable: true, get: () => request.read([entry]) });
    }
    this.values = Object.freeze(values) as Readonly<R>;
    this.#entries = Object.freeze(entries);
    Object.freeze(this);
  }

  select<T extends object>(requires: ResourceRequirements<T>): ResourceBindings<T> {
    return new ResourceBindings(requires, this.#entries);
  }
}

export function checkResourceRequests(available: ResourceRequirements, requested: readonly ResourceRequest<unknown>[]): void {
  const offers = resourceRequests(available).map((request) => request.offer);
  for (const request of requested) {
    if (!offers.includes(request.offer)) throw new Error(`Child resource request is not provided: ${request.offer.name}`);
  }
}

export function checkResourceProviders<P>(requested: readonly ResourceRequest<unknown>[], providers: readonly ResourceProvider<P>[]): void {
  for (const request of requested) {
    const matches = providers.filter((provider) => provider.offer === request.offer);
    if (matches.length !== 1) throw new Error(`Expected one resource provider for ${request.offer.name}, received ${matches.length}`);
  }
}

/** Initialization checks publication identity; each call obtains values through the published access form. */
export function bindResources<P, R extends object>(requires: ResourceRequirements<R>, providers: readonly ResourceProvider<P>[]): (parent: P) => ResourceBindings<R> {
  const requests = Object.freeze({ ...requires });
  const declared = Object.keys(requests).map((name) => requests[name as keyof R]);
  checkResourceProviders(declared, providers);
  const offers = new Set(declared.map((request) => request.offer));
  const selected = providers.filter((provider) => offers.has(provider.offer));
  return (parent) =>
    new ResourceBindings(
      requests,
      selected.map((provider) => {
        const value = new Initializer(() => provider.resolve(parent));
        if (provider.timing === 'binding') value.get();
        return Object.freeze({ offer: provider.offer, get: () => value.get() });
      }),
    );
}
