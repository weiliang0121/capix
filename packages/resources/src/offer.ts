import { randomUUID } from 'node:crypto';
import type { ResourceEndpointActivity } from './endpoint.js';
import { resourceMethods, type ResourceMethodDeclarations, type ResourceMethods, type ResourceMethodsDeclaration, type ResourceMethodsSource } from './methods.js';

import { ResourceRequest, type ResourceIdentity } from './request.js';
import type { ResourceEndpointDefinition, ResourceProvider } from './provider.js';

export { ResourceRequest, type ResourceIdentity, type ResourceRequests, type ResourcesOf } from './request.js';
export type { ResourceProvider } from './provider.js';

declare const refinementInput: unique symbol;

export interface ResourceRefinement<Input> {
  readonly offer: ResourceIdentity;
  readonly [refinementInput]: (input: Input) => void;
}

class IssuedResourceRefinement<Input> implements ResourceRefinement<Input> {
  declare readonly [refinementInput]: (input: Input) => void;

  constructor(readonly offer: ResourceIdentity) {
    Object.freeze(this);
  }
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

/** Precise low-level exposure for synchronous values, subscriptions and fixed-effect endpoints. */
export interface ResourceExposureDeclaration<Source, Value, Captured = Source, Selection = never> extends ResourceCapture<Source, Captured, Selection> {
  readonly name?: string;
  readonly expose: (captured: Captured, activity: ResourceEndpointActivity) => Value;
  readonly methods?: never;
  readonly timing?: 'binding' | 'access';
}

type ResourceDeclaration = ResourceMethodsDeclaration<ResourceMethodDeclarations, any, any> | ResourceExposureDeclaration<any, any, any, any>;

/** The resource owns capture, its public endpoint, and the typed description of runtime use. */
class ResourceOfferImplementation<Source, Value, Captured = Source, Selection = never> {
  readonly #identity: ResourceEndpointDefinition;
  readonly #createEndpoint: (captured: Captured, activity: ResourceEndpointActivity) => Value;
  readonly #capture?: (source: Source) => unknown;
  readonly #refine?: (captured: unknown, selection: Selection) => unknown;
  readonly #describe?: (captured: Captured) => unknown;

  constructor(declaration: ResourceDeclaration) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new TypeError('Resource access requires a configuration object');
    const id = randomUUID();
    const name = declaration.name ?? `resource:${id}`;
    if (typeof name !== 'string' || !/\S/.test(name)) throw new TypeError('Resource access name must be nonempty');
    if (declaration.methods && declaration.expose) throw new TypeError('Resource declaration must use either methods or precise exposure');
    if (declaration.methods) {
      this.#createEndpoint = resourceMethods(declaration.methods, declaration.observation) as (captured: Captured, activity: ResourceEndpointActivity) => Value;
      this.#describe = declaration.observation?.source?.bind(declaration.observation);
    } else {
      if (typeof declaration.expose !== 'function') throw new TypeError('Resource access requires an endpoint declaration');
      this.#createEndpoint = declaration.expose.bind(declaration);
      this.#describe = declaration.describe?.bind(declaration);
    }
    this.#capture = declaration.capture?.bind(declaration);
    this.#refine = declaration.refine?.bind(declaration);
    this.#identity = Object.freeze({
      id,
      name,
      timing: declaration.timing ?? 'access',
      createEndpoint: (material: unknown, activity: ResourceEndpointActivity) => this.#createEndpoint(material as Captured, activity),
      describe: (material: unknown) => this.#describe?.(material as Captured) ?? null,
    });
    Object.freeze(this);
  }
  get id(): string {
    return this.#identity.id;
  }
  get name(): string {
    return this.#identity.name;
  }
  get timing(): 'binding' | 'access' {
    return this.#identity.timing;
  }
  request(): ResourceRequest<Value> {
    return new ResourceRequest<Value>(this.#identity);
  }
  /** Trusted assembly maps child input to a resource-owned refinement, never to a replacement source. */
  refine<Input>(select: (input: Input) => Selection): ResourceRefinement<Input> {
    const refine = this.#refine;
    if (!refine) throw new Error(`Resource does not support refinement: ${this.#identity.name}`);
    const refinement = new IssuedResourceRefinement<Input>(this.#identity);
    refinements.set(refinement, { offer: this.#identity, apply: (captured, input) => refine(captured, select(input as Input)) });
    return refinement;
  }
  provide<ProviderSource>(select: (source: ProviderSource) => Source): ResourceProvider<ProviderSource> {
    if (typeof select !== 'function') throw new TypeError('Resource source selection must be a function');
    return Object.freeze({
      offer: this.#identity,
      readMaterial: (source: ProviderSource) => {
        const value = select(source);
        return this.#capture ? this.#capture(value) : value;
      },
    });
  }
}

/** Both endpoint declarations produce the same offer object; methods infer their complete endpoint type. */
export type ResourceOffer<Source, Value, Captured = Source, Selection = never> = ResourceOfferImplementation<Source, Value, Captured, Selection>;
export interface ResourceOfferConstructor {
  new <const Methods extends ResourceMethodDeclarations, Source, Selection = never>(declaration: ResourceMethodsDeclaration<Methods, Source, Selection> & { readonly capture: (source: Source) => ResourceMethodsSource<Methods> }): ResourceOffer<Source, ResourceMethods<Methods>, ResourceMethodsSource<Methods>, Selection>;
  new <const Methods extends ResourceMethodDeclarations, Selection = never>(declaration: ResourceMethodsDeclaration<Methods, ResourceMethodsSource<Methods>, Selection> & { readonly capture?: never }): ResourceOffer<ResourceMethodsSource<Methods>, ResourceMethods<Methods>, ResourceMethodsSource<Methods>, Selection>;
  new <Source, Value, Selection = never>(declaration: ResourceExposureDeclaration<Source, Value, Source, Selection> & { readonly capture?: never }): ResourceOffer<Source, Value, Source, Selection>;
  new <Source, Value, Captured = Source, Selection = never>(declaration: ResourceExposureDeclaration<Source, Value, Captured, Selection> & { readonly capture: (source: Source) => Captured }): ResourceOffer<Source, Value, Captured, Selection>;
}
export const ResourceOffer: ResourceOfferConstructor = ResourceOfferImplementation;
