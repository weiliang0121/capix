import { randomUUID } from 'node:crypto';
import { ResourceActivity, ResourceSession, type ResourceOwner } from './activity.js';
import { Initializer } from '../initializer.js';
import { ResourceSupply } from './supply.js';
import { ResourceRequest, type ResourceProvider, type ResourceValue, type ResourceRefinement } from './offer.js';

export type ResourceRequirements<Resources extends object = object> = { readonly [Key in keyof Resources]: ResourceRequest<Resources[Key]> };

export function resourceRequests<Resources extends object>(requires: ResourceRequirements<Resources>): readonly ResourceRequest<unknown>[] {
  return Object.keys(requires).map((name) => requires[name as keyof Resources]);
}

/** Supply captures survive phase changes; local endpoints do not cross declaration phases. */
export class ResourceBindings<Resources extends object = object> {
  readonly values: Readonly<Resources>;
  readonly supply: ResourceSupply;
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
  readonly #closed = new Set<string>();

  constructor(requires: ResourceRequirements<Resources>, available: readonly ResourceValue[] = [], initial: ResourceRequirements = requires, supply: ResourceRequirements = requires) {
    this.supply = new ResourceSupply(available).select(supply);
    this.#entries = this.supply.entries;
    this.#initial = initial;
    this.values = this.view(initial as ResourceRequirements<Resources>);
  }

  /** Each declaration receives a distinct, revocable named view, never this binding. */
  view<SelectedResources extends object>(requires: ResourceRequirements<SelectedResources>, phase = 'run'): Readonly<SelectedResources> {
    const values = {};
    let round = this.#attached ? this.round() : undefined;
    for (const name of Object.keys(requires)) {
      const request = requires[name as keyof SelectedResources];
      const entry = this.#entries.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      Object.defineProperty(values, name, {
        enumerable: true,
        get: () => {
          try {
            round ??= this.round();
            this.session(phase, round).validate();
            return request.read([{ offer: entry.offer, get: () => this.local(entry, phase, round).endpoint.get() }]);
          } catch (error) {
            this.#session.error(error);
            throw error;
          }
        },
      });
    }
    return Object.freeze(values) as Readonly<SelectedResources>;
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

  /** Activate only the current entry's resources; other phase endpoints remain unrealized. */
  start(phase = 'run'): void {
    if (this.#started) throw new Error('Resource access has already started');
    this.#started = true;
    this.activate(phase, this.#initial);
  }

  activate(phase: string, requires: ResourceRequirements): void {
    if (!this.#started) throw new Error('Resource access requires a started invocation');
    this.#phase = phase;
    for (const request of resourceRequests(requires)) {
      const entry = this.#entries.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
      const local = this.local(entry, phase, this.round());
      if (entry.timing === 'binding') local.endpoint.get();
    }
  }

  /** Permanently revoke an exclusive phase window without recapturing its supply. */
  close(phase: string): void {
    this.#closed.add(`${phase}:${this.round()}`);
  }

  select<SelectedResources extends object, Input = unknown>(requires: ResourceRequirements<SelectedResources>, initial: ResourceRequirements = requires, selection?: { readonly input: Input; readonly refinements: readonly ResourceRefinement<Input>[]; readonly supply?: ResourceRequirements }): ResourceBindings<SelectedResources> {
    let supply = this.supply.select(selection?.supply ?? requires);
    if (selection?.refinements.length) supply = supply.refine(selection.input, selection.refinements);
    return new ResourceBindings(requires, supply.entries, initial, selection?.supply);
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

  private round(): number {
    return Math.max(1, this.#session.owner?.round?.() ?? 1);
  }

  private session(phase: string, round = this.round()): ResourceSession {
    const key = `${phase}:${round}`;
    let session = this.#scopes.get(key);
    if (!session) {
      session = this.#session.scope(() => {
        if (this.#closed.has(key)) throw new Error('Resource access window is closed');
        if (phase !== this.#phase) throw new Error('Resource access belongs to an inactive declaration phase');
        if (round !== this.round()) throw new Error('Resource access belongs to an inactive declaration round');
      });
      this.#scopes.set(key, session);
    }
    return session;
  }

  private local(entry: ResourceValue, phase: string, round = this.round()) {
    if (this.#attached && !this.#started) throw new Error('Resource access requires a started invocation');
    const key = `${phase}:${round}`;
    let locals = this.#locals.get(key);
    if (!locals) {
      locals = new Map();
      this.#locals.set(key, locals);
    }
    const existing = locals.get(entry);
    if (existing) return existing;
    const activity = new ResourceActivity(this.session(phase, round), entry.offer.name, entry.supplyId);
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

export function checkResourceProviders<Source>(requested: readonly ResourceRequest<unknown>[], providers: readonly ResourceProvider<Source>[]): void {
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
export function bindResources<Source, Resources extends object>(requires: ResourceRequirements<Resources>, providers: readonly ResourceProvider<Source>[]): (parent: Source) => ResourceBindings<Resources> {
  const requests = Object.freeze({ ...requires });
  const declared = Object.keys(requests).map((name) => requests[name as keyof Resources]);
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
