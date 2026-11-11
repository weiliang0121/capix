import { ResourceActivity } from './activity.js';
import type { ResourceEndpointActivity } from './endpoint.js';
import { Initializer } from './internal/initializer.js';
import { synchronous } from './internal/synchronous.js';
import { captureResourceOwner, ResourceAccessClosed, type ResourceOwner, type ResourceWindow } from './ports.js';
import type { ResourceRequirements } from './request.js';
import { ResourceSupply, type ResourceSupplyEntry } from './supply.js';

/** Local host checks and per-owner fact deduplication; no phase or runtime types enter this package. */
export interface ResourceAccessHooks {
  readonly validate?: () => void;
  readonly bound?: (entry: ResourceSupplyEntry) => boolean;
  readonly available?: (entry: ResourceSupplyEntry) => boolean;
}

/** One irreversible access window, owning endpoints but never owning the supplied entities. */
export class ResourceAccess<Resources extends object = object> implements ResourceWindow {
  readonly endpoints: Readonly<Resources>;
  readonly supply: ResourceSupply;
  readonly #owner?: ResourceOwner;
  readonly #hooks: ResourceAccessHooks;
  readonly #activity: ResourceActivity;
  readonly #locals = new Map<ResourceSupplyEntry, { activity: ResourceEndpointActivity; endpoint: Initializer<unknown> }>();
  #closed?: ResourceAccessClosed;
  #started = false;

  constructor(deps: ResourceRequirements<Resources>, supply: ResourceSupply | (() => ResourceSupply), owner?: ResourceOwner, hooks: ResourceAccessHooks = {}) {
    this.#owner = captureResourceOwner(owner);
    this.#hooks = Object.freeze({ validate: hooks.validate?.bind(hooks), bound: hooks.bound?.bind(hooks), available: hooks.available?.bind(hooks) });
    this.#activity = new ResourceActivity(this, this.#owner);
    try {
      this.#activity.validate();
      this.supply = (typeof supply === 'function' ? supply() : supply).select(deps);
      this.#activity.validate();
      this.endpoints = this.view(deps);
    } catch (error) {
      this.failOpening(error);
    }
  }

  get signal(): AbortSignal | undefined {
    return this.#owner?.signal;
  }

  assertOpen(): void {
    if (this.#closed) throw this.#closed;
    this.#owner?.validate();
    if (this.#closed) throw this.#closed;
    synchronous(this.#hooks.validate?.(), 'Resource access validation');
    if (this.#closed) throw this.#closed;
  }

  /** All requests are checked before any endpoint is realized. Aliases share their window's endpoint. */
  view<Selected extends object>(deps: ResourceRequirements<Selected>): Readonly<Selected> {
    const entries = Object.keys(deps).map((name) => [name, this.supply.require(deps[name as keyof Selected].offer)] as const);
    const values = {};
    for (const [name, entry] of entries) {
      Object.defineProperty(values, name, {
        enumerable: true,
        get: () => {
          this.#activity.validate();
          if (!this.#started) this.#activity.reject(new Error('Resource access requires a started window'));
          return this.local(entry).endpoint.get();
        },
      });
    }
    return Object.freeze(values) as Readonly<Selected>;
  }

  /** Eager exposures are realized once the host has established this access owner. */
  start(): void {
    this.#activity.validate();
    if (this.#started) throw new Error('Resource access has already started');
    this.#started = true;
    try {
      for (const entry of this.supply.entries) {
        const local = this.local(entry);
        if (entry.offer.timing === 'binding') local.endpoint.get();
      }
      this.#activity.validate();
    } catch (error) {
      this.failOpening(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = new ResourceAccessClosed();
    this.#activity.close(this.#closed);
  }

  /** Opening owns any partially established operations; preserve its failure through closing. */
  private failOpening(error: unknown): never {
    let failure = error;
    try {
      this.close();
    } catch (closing) {
      failure = new AggregateError([error, closing], 'Resource opening and cleanup both failed', { cause: error });
    }
    this.#activity.reject(failure);
  }

  private local(entry: ResourceSupplyEntry) {
    const existing = this.#locals.get(entry);
    if (existing) return existing;
    const activity = this.#activity.forResource(entry);
    const endpoint = new Initializer(() => {
      this.#activity.validate();
      let material: unknown;
      let value: unknown;
      try {
        material = entry.readMaterial();
        this.#activity.validate();
        value = entry.offer.createEndpoint(material, activity);
        if (value === undefined) throw new Error(`Unfulfilled resource request: ${entry.offer.name}`);
        this.#activity.validate();
      } catch (error) {
        this.#activity.error(error);
        try {
          activity.unavailable(error);
        } catch (observation) {
          this.#activity.reject(new AggregateError([error, observation], 'Resource construction and observation both failed', { cause: error }));
        }
        throw error;
      }
      if (this.shouldPublish(this.#hooks.available, entry)) activity.available(() => entry.offer.describe(material));
      this.#activity.validate();
      return value;
    });
    const local = { activity, endpoint };
    this.#locals.set(entry, local);
    if (this.shouldPublish(this.#hooks.bound, entry)) activity.bound();
    this.#activity.validate();
    return local;
  }

  private shouldPublish(hook: ((entry: ResourceSupplyEntry) => boolean) | undefined, entry: ResourceSupplyEntry): boolean {
    if (!hook) return true;
    try {
      const result: unknown = synchronous(hook(entry), 'Resource publication hook');
      if (typeof result !== 'boolean') throw new TypeError('Resource publication hook must return a boolean');
      return result;
    } catch (error) {
      this.#activity.reject(error);
    }
  }
}
