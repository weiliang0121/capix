import { randomUUID } from 'node:crypto';
import { ResourceActivity, ResourceSession, type ResourceOwner } from './activity.js';
import { Initializer } from '../initialization/initializer.js';
import { ResourceRequest, type ResourceProvider, type ResourceValue } from './offer.js';

export type ResourceRequirements<R extends object = object> = { readonly [K in keyof R]: ResourceRequest<R[K]> };

export function resourceRequests<R extends object>(requires: ResourceRequirements<R>): readonly ResourceRequest<unknown>[] {
  return Object.keys(requires).map((name) => requires[name as keyof R]);
}

/** Supply captures survive phase changes; local endpoints do not cross declaration phases. */
export class ResourceBindings<R extends object = object> {
  readonly values: Readonly<R>;
  readonly #entries: readonly ResourceValue[];
  readonly #initial: ResourceRequirements;
  readonly #locals = new Map<string, Map<ResourceValue, { activity: ResourceActivity; endpoint: Initializer<unknown> }>>();
  readonly #scopes = new Map<string, ResourceSession>();
  readonly #bound = new Set<ResourceValue>();
  readonly #available = new Set<ResourceValue>();
  #restriction?: () => void;
  #session = new ResourceSession(undefined, () => this.#restriction?.());
  #attached = false;
  #started = false;
  #phase = 'run';

  constructor(requires: ResourceRequirements<R>, available: readonly ResourceValue[] = [], initial: ResourceRequirements = requires) {
    const entries: ResourceValue[] = [];
    for (const request of resourceRequests(requires)) {
      const entry = available.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      if (!entries.includes(entry)) entries.push(entry);
    }
    this.#entries = Object.freeze(entries);
    this.#initial = initial;
    this.values = this.view(initial as ResourceRequirements<R>);
  }

  /** Each declaration receives a distinct, revocable named view, never this binding. */
  view<T extends object>(requires: ResourceRequirements<T>, phase = 'run'): Readonly<T> {
    const values = {};
    for (const name of Object.keys(requires)) {
      const request = requires[name as keyof T];
      const entry = this.#entries.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      Object.defineProperty(values, name, {
        enumerable: true,
        get: () => {
          try {
            this.session(phase).validate();
            return request.read([{ offer: entry.offer, get: () => this.local(entry, phase).endpoint.get() }]);
          } catch (error) {
            this.#session.error(error);
            throw error;
          }
        },
      });
    }
    return Object.freeze(values) as Readonly<T>;
  }

  /** A construction window may end without creating an invocation or a fake origin. */
  restrict(validate: () => void): void {
    if (this.#restriction || this.#attached || this.#started || this.#locals.size) throw new Error('Resource access is already established');
    this.#restriction = validate;
  }

  attach(owner: ResourceOwner): void {
    if (this.#attached || this.#started || this.#locals.size) throw new Error('Resource access is already established');
    this.#attached = true;
    this.#session = new ResourceSession(owner, () => this.#restriction?.());
    this.#scopes.clear();
  }

  /** Start only the normal-work access; handler-only endpoints remain unrealized. */
  start(): void {
    if (this.#started) throw new Error('Resource access has already started');
    this.#started = true;
    this.activate('run', this.#initial);
  }

  activate(phase: string, requires: ResourceRequirements): void {
    if (!this.#started) throw new Error('Resource access requires a started invocation');
    this.#phase = phase;
    for (const request of resourceRequests(requires)) {
      const entry = this.#entries.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      const local = this.local(entry, phase);
      if (entry.timing === 'binding') local.endpoint.get();
    }
  }

  select<T extends object>(requires: ResourceRequirements<T>, initial: ResourceRequirements = requires): ResourceBindings<T> {
    return new ResourceBindings(requires, this.#entries, initial);
  }

  /** Combine supply captures for a distinct declaration, without exposing another declaration's endpoints. */
  supplement(others: readonly ResourceBindings[]): ResourceBindings {
    const entries = [...this.#entries];
    for (const other of others) {
      for (const entry of other.#entries) {
        const previous = entries.find((candidate) => candidate.offer === entry.offer);
        if (previous && previous !== entry) throw new Error(`Ambiguous resource supply: ${entry.offer.name}`);
        if (!previous) entries.push(entry);
      }
    }
    const requests = Object.fromEntries(entries.map((entry, index) => [String(index), new ResourceRequest(entry.offer)]));
    return new ResourceBindings(requests, entries);
  }

  provides(request: ResourceRequest<unknown>): boolean {
    return this.#entries.some((entry) => entry.offer === request.offer);
  }

  private session(phase: string): ResourceSession {
    let session = this.#scopes.get(phase);
    if (!session) {
      session = this.#session.scope(() => {
        if (phase !== this.#phase) throw new Error('Resource access belongs to an inactive declaration phase');
      });
      this.#scopes.set(phase, session);
    }
    return session;
  }

  private local(entry: ResourceValue, phase: string) {
    if (this.#attached && !this.#started) throw new Error('Resource access requires a started invocation');
    let locals = this.#locals.get(phase);
    if (!locals) {
      locals = new Map();
      this.#locals.set(phase, locals);
    }
    const existing = locals.get(entry);
    if (existing) return existing;
    const activity = new ResourceActivity(this.session(phase), entry.offer.name, entry.supplyId);
    const endpoint = new Initializer(() => {
      let captured: unknown;
      let value: unknown;
      try {
        captured = entry.capture();
        value = entry.expose(captured, activity);
      } catch (error) {
        this.#session.error(error);
        try {
          activity.unavailable(error);
        } catch (observation) {
          throw new AggregateError([error, observation], 'Resource construction and observation both failed', { cause: error });
        }
        throw error;
      }
      if (!this.#available.has(entry)) {
        this.#available.add(entry);
        activity.available(() => entry.describe(captured));
      }
      return value;
    });
    const local = { activity, endpoint };
    locals.set(entry, local);
    if (this.#started && !this.#bound.has(entry)) {
      this.#bound.add(entry);
      activity.bound();
    }
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
