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
export class ResourceRequest<Value> {
  constructor(readonly offer: ResourceIdentity) {
    Object.freeze(this);
  }
  read(values: readonly Pick<ResourceValue, 'offer' | 'get'>[]): Value {
    const binding = values.find((value) => value.offer === this.offer);
    const value = binding?.get();
    if (!binding || isUndefined(value)) throw new Error(`Unfulfilled resource request: ${this.offer.name}`);
    return value as Value;
  }
}
export interface ResourceProvider<Source> {
  readonly offer: ResourceIdentity;
  readonly timing: 'binding' | 'access';
  resolve(source: Source): unknown;
  expose(captured: unknown, activity: ResourceActivity): unknown;
  describe(captured: unknown): unknown;
}
export interface ResourceCapture<Source, Captured> {
  readonly capture?: (source: Source) => Captured;
  readonly describe?: (captured: Captured) => unknown;
}

/** The resource owns capture, its public endpoint, and the typed description of runtime use. */
export class ResourceOffer<Source, Value, Captured = Source> {
  readonly #identity: ResourceIdentity;
  readonly #expose: (captured: Captured, activity: ResourceActivity) => Value;
  readonly #options: ResourceCapture<Source, Captured>;
  readonly timing: 'binding' | 'access';

  constructor(name: string, expose: (source: Source, activity: ResourceActivity) => Value, timing?: 'binding' | 'access', options?: ResourceCapture<Source, Source>);
  constructor(name: string, expose: (captured: Captured, activity: ResourceActivity) => Value, timing: 'binding' | 'access', options: ResourceCapture<Source, Captured> & { capture: (source: Source) => Captured });
  constructor(name: string, expose: ((captured: Captured, activity: ResourceActivity) => Value) | ((source: Source, activity: ResourceActivity) => Value), timing: 'binding' | 'access' = 'access', options: ResourceCapture<Source, Captured> | ResourceCapture<Source, Source> = {}) {
    if (!isNonBlankString(name)) throw new TypeError('Resource access requires a stable name');
    this.#identity = Object.freeze({ name });
    this.#expose = expose as (captured: Captured, activity: ResourceActivity) => Value;
    this.#options = options as ResourceCapture<Source, Captured>;
    this.timing = timing;
    Object.freeze(this);
  }
  request(): ResourceRequest<Value> {
    return new ResourceRequest<Value>(this.#identity);
  }
  provide<ProviderSource>(select: (source: ProviderSource) => Source): ResourceProvider<ProviderSource> {
    return Object.freeze({
      offer: this.#identity,
      timing: this.timing,
      resolve: (source: ProviderSource) => {
        const value = select(source);
        return this.#options.capture ? this.#options.capture(value) : value;
      },
      expose: (captured: unknown, activity: ResourceActivity) => this.#expose(captured as Captured, activity),
      describe: (captured: unknown) => this.#options.describe?.(captured as Captured) ?? null,
    });
  }
}
