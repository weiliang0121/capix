import { isUndefined } from 'es-toolkit/predicate';

export interface ResourceIdentity {
  readonly name: string;
}
export interface ResourceValue {
  readonly offer: ResourceIdentity;
  get(): unknown;
}

/** A formal request for an access form published by a resource. Names are diagnostic only. */
export class ResourceRequest<T> {
  constructor(readonly offer: ResourceIdentity) {
    Object.freeze(this);
  }

  read(values: readonly ResourceValue[]): T {
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
}

/** Defined by the resource owner. Requesters select the offer; providers supply its source. */
export class ResourceOffer<S, T> {
  readonly #identity: ResourceIdentity;
  readonly #expose: (source: S) => T;

  constructor(
    name: string,
    expose: (source: S) => T,
    readonly timing: 'binding' | 'access' = 'access',
  ) {
    this.#identity = Object.freeze({ name });
    this.#expose = expose;
    Object.freeze(this);
  }

  request(): ResourceRequest<T> {
    return new ResourceRequest<T>(this.#identity);
  }

  provide<P>(source: (parent: P) => S): ResourceProvider<P> {
    return Object.freeze({ offer: this.#identity, timing: this.timing, resolve: (parent: P) => this.#expose(source(parent)) });
  }
}
