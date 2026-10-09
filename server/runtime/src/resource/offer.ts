import { isUndefined } from 'es-toolkit/predicate';
import type { ResourceActivity } from './activity.js';
import { isNonBlankString } from '../value/string.js';

export interface ResourceIdentity {
  readonly name: string;
}
export interface ResourceValue {
  readonly offer: ResourceIdentity;
  readonly supplyId: string;
  readonly timing: 'binding' | 'access';
  capture(): unknown;
  expose(captured: unknown, activity: ResourceActivity): unknown;
  describe(captured: unknown): unknown;
  get(): unknown;
}

/** A formal request for a published access form. Object identity controls fulfillment; name identifies facts. */
export class ResourceRequest<T> {
  constructor(readonly offer: ResourceIdentity) {
    Object.freeze(this);
  }
  read(values: readonly Pick<ResourceValue, 'offer' | 'get'>[]): T {
    const binding = values.find((value) => value.offer === this.offer);
    const value = binding?.get();
    if (!binding || isUndefined(value)) throw new Error(`Unfulfilled resource request: ${this.offer.name}`);
    return value as T;
  }
}
export interface ResourceProvider<P> {
  readonly offer: ResourceIdentity;
  readonly timing: 'binding' | 'access';
  resolve(parent: P): unknown;
  expose(captured: unknown, activity: ResourceActivity): unknown;
  describe(captured: unknown): unknown;
}
export interface ResourceCapture<S, C> {
  readonly capture?: (source: S) => C;
  readonly describe?: (captured: C) => unknown;
}

/** The resource owns capture, its public endpoint, and the typed description of runtime use. */
export class ResourceOffer<S, T, C = S> {
  readonly #identity: ResourceIdentity;
  readonly #expose: (captured: C, activity: ResourceActivity) => T;
  readonly #options: ResourceCapture<S, C>;
  readonly timing: 'binding' | 'access';

  constructor(name: string, expose: (source: S, activity: ResourceActivity) => T, timing?: 'binding' | 'access', options?: ResourceCapture<S, S>);
  constructor(name: string, expose: (captured: C, activity: ResourceActivity) => T, timing: 'binding' | 'access', options: ResourceCapture<S, C> & { capture: (source: S) => C });
  constructor(name: string, expose: ((captured: C, activity: ResourceActivity) => T) | ((source: S, activity: ResourceActivity) => T), timing: 'binding' | 'access' = 'access', options: ResourceCapture<S, C> | ResourceCapture<S, S> = {}) {
    if (!isNonBlankString(name)) throw new TypeError('Resource access requires a stable name');
    this.#identity = Object.freeze({ name });
    this.#expose = expose as (captured: C, activity: ResourceActivity) => T;
    this.#options = options as ResourceCapture<S, C>;
    this.timing = timing;
    Object.freeze(this);
  }
  request(): ResourceRequest<T> {
    return new ResourceRequest<T>(this.#identity);
  }
  provide<P>(source: (parent: P) => S): ResourceProvider<P> {
    return Object.freeze({
      offer: this.#identity,
      timing: this.timing,
      resolve: (parent: P) => {
        const value = source(parent);
        return this.#options.capture ? this.#options.capture(value) : value;
      },
      expose: (captured: unknown, activity: ResourceActivity) => this.#expose(captured as C, activity),
      describe: (captured: unknown) => this.#options.describe?.(captured as C) ?? null,
    });
  }
}
