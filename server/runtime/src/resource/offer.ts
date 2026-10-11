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
declare const refinementInput: unique symbol;

export interface ResourceRefinement<Input> {
  readonly offer: ResourceIdentity;
  readonly [refinementInput]: (input: Input) => void;
}

const refinements = new WeakMap<object, { readonly offer: ResourceIdentity; readonly apply: (captured: unknown, input: unknown) => unknown }>();

/** Only the publishing offer can issue a refinement; assembly cannot substitute capture logic. */
export function isResourceRefinement(value: object): boolean {
  return refinements.has(value);
}

export function applyResourceRefinement<Input>(refinement: ResourceRefinement<Input>, offer: ResourceIdentity, captured: unknown, input: Input): unknown {
  const issued = refinements.get(refinement);
  if (!issued || issued.offer !== offer) throw new Error('Resource refinement was not issued by this offer');
  return issued.apply(captured, input);
}

export interface ResourceCapture<Source, Captured, Selection = never> {
  readonly capture?: (source: Source) => Captured;
  readonly describe?: (captured: Captured) => unknown;
  /** Return an independent narrower capture; the resource validates its own access constraints. */
  readonly refine?: (captured: Captured, selection: Selection) => Captured;
}

/** The resource owns capture, its public endpoint, and the typed description of runtime use. */
export class ResourceOffer<Source, Value, Captured = Source, Selection = never> {
  readonly #identity: ResourceIdentity;
  readonly #expose: (captured: Captured, activity: ResourceActivity) => Value;
  readonly #options: ResourceCapture<Source, Captured, Selection>;
  readonly timing: 'binding' | 'access';

  constructor(name: string, expose: (source: Source, activity: ResourceActivity) => Value, timing?: 'binding' | 'access', options?: ResourceCapture<Source, Source, Selection>);
  constructor(name: string, expose: (captured: Captured, activity: ResourceActivity) => Value, timing: 'binding' | 'access', options: ResourceCapture<Source, Captured, Selection> & { capture: (source: Source) => Captured });
  constructor(name: string, expose: ((captured: Captured, activity: ResourceActivity) => Value) | ((source: Source, activity: ResourceActivity) => Value), timing: 'binding' | 'access' = 'access', options: ResourceCapture<Source, Captured, Selection> | ResourceCapture<Source, Source, Selection> = {}) {
    if (!isNonBlankString(name)) throw new TypeError('Resource access requires a stable name');
    this.#identity = Object.freeze({ name });
    this.#expose = expose as (captured: Captured, activity: ResourceActivity) => Value;
    this.#options = options as ResourceCapture<Source, Captured, Selection>;
    this.timing = timing;
    Object.freeze(this);
  }
  request(): ResourceRequest<Value> {
    return new ResourceRequest<Value>(this.#identity);
  }
  /** Trusted assembly maps child input to a resource-owned refinement, never to a replacement source. */
  refine<Input>(select: (input: Input) => Selection): ResourceRefinement<Input> {
    const refine = this.#options.refine;
    if (!refine) throw new Error(`Resource does not support refinement: ${this.#identity.name}`);
    const refinement = Object.freeze({ offer: this.#identity }) as ResourceRefinement<Input>;
    refinements.set(refinement, { offer: this.#identity, apply: (captured, input) => refine(captured as Captured, select(input as Input)) });
    return refinement;
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
