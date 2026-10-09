import { randomUUID } from 'node:crypto';
import { ResourceActivity, ResourceSession, type ResourceOwner } from './activity.js';
import { Initializer } from '../initialization/initializer.js';
import { type ResourceRequest, type ResourceProvider, type ResourceValue } from './offer.js';

export type ResourceRequirements<R extends object = object> = { readonly [K in keyof R]: ResourceRequest<R[K]> };

export function resourceRequests<R extends object>(requires: ResourceRequirements<R>): readonly ResourceRequest<unknown>[] {
  return Object.keys(requires).map((name) => requires[name as keyof R]);
}

/** Shares captured supplies, but each call gets its own provenance-bound endpoint and fact sequence. */
export class ResourceBindings<R extends object = object> {
  readonly values: Readonly<R>;
  readonly #entries: readonly ResourceValue[];
  readonly #local = new Map<ResourceValue, { activity: ResourceActivity; endpoint: Initializer<unknown> }>();
  #restriction?: () => void;
  #session = new ResourceSession(undefined, () => this.#restriction?.());
  #attached = false;
  #started = false;

  constructor(requires: ResourceRequirements<R>, available: readonly ResourceValue[] = []) {
    const entries: ResourceValue[] = [];
    const values = {};
    for (const name of Object.keys(requires)) {
      const request = requires[name as keyof R];
      const entry = available.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      if (!entries.includes(entry)) entries.push(entry);
      Object.defineProperty(values, name, {
        enumerable: true,
        get: () =>
          request.read([
            {
              offer: entry.offer,
              get: () => {
                this.#session.validate();
                return this.local(entry).endpoint.get();
              },
            },
          ]),
      });
    }
    this.values = Object.freeze(values) as Readonly<R>;
    this.#entries = Object.freeze(entries);
  }

  /** A construction window may end without creating an invocation or a fake origin. */
  restrict(validate: () => void): void {
    if (this.#restriction || this.#attached || this.#started || this.#local.size) throw new Error('Resource access is already established');
    this.#restriction = validate;
  }

  attach(owner: ResourceOwner): void {
    if (this.#attached || this.#started || this.#local.size) throw new Error('Resource access is already established');
    this.#attached = true;
    this.#session = new ResourceSession(owner, () => this.#restriction?.());
  }

  /** Called after the owning invocation record exists. Static assembly and entry access never record. */
  start(): void {
    if (this.#started) throw new Error('Resource access has already started');
    this.#started = true;
    for (const entry of this.#entries) {
      const local = this.local(entry);
      local.activity.bound();
      if (entry.timing === 'binding') local.endpoint.get();
    }
  }

  select<T extends object>(requires: ResourceRequirements<T>): ResourceBindings<T> {
    return new ResourceBindings(requires, this.#entries);
  }

  private local(entry: ResourceValue) {
    if (this.#attached && !this.#started) throw new Error('Resource access requires a started invocation');
    const existing = this.#local.get(entry);
    if (existing) return existing;
    const activity = new ResourceActivity(this.#session, entry.offer.name, entry.supplyId);
    const endpoint = new Initializer(() => {
      let captured: unknown;
      let value: unknown;
      try {
        captured = entry.capture();
        value = entry.expose(captured, activity);
      } catch (error) {
        try {
          activity.unavailable(error);
        } catch (recordingError) {
          throw new AggregateError([error, recordingError], 'Resource acquisition and failure recording both failed', { cause: error });
        }
        throw error;
      }
      activity.available(() => entry.describe(captured));
      return value;
    });
    const local = { activity, endpoint };
    this.#local.set(entry, local);
    return local;
  }
}

export function checkResourceRequests(available: ResourceRequirements, requested: readonly ResourceRequest<unknown>[]): void {
  const offers = resourceRequests(available).map((request) => request.offer);
  for (const request of requested) {
    if (!offers.includes(request.offer)) throw new Error(`Child resource request is not provided: ${request.offer.name}`);
  }
}

export function checkResourceProviders<P>(requested: readonly ResourceRequest<unknown>[], providers: readonly ResourceProvider<P>[]): void {
  const names = new Map<string, ResourceRequest<unknown>['offer']>();
  for (const request of requested) {
    const previous = names.get(request.offer.name);
    if (previous && previous !== request.offer) throw new Error(`Different resource offers use the same access name: ${request.offer.name}`);
    names.set(request.offer.name, request.offer);
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
        return Object.freeze({ offer: provider.offer, supplyId: randomUUID(), timing: provider.timing, capture: () => value.get(), expose: (captured: unknown, activity: ResourceActivity) => provider.expose(captured, activity), describe: (captured: unknown) => provider.describe(captured), get: () => value.get() });
      }),
    );
}
