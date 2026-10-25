import type { AnyCallable } from '../binding/declarations.js';
import type { ChildResourceBinding } from '../binding/resources.js';
import type { CallableInput } from '../definition/signature.js';
import type { ChildCallable } from '../definition/children.js';
import type { InteractionContract } from '../interaction/contract.js';
import type { InteractionChannel, Interactions } from '../interaction/interactions.js';
import { Callable } from '../structure/callable.js';
import { ResourceOffer, type ResourceIdentity, type ResourceProvider, type ResourceRefinement, Resource } from '@capix/resources';

export interface ResourceRegistration {
  readonly offer: ResourceIdentity;
  bind(interactions?: Interactions): ResourceProvider<unknown>;
}

export interface ResourceCaptureScope<Options> {
  readonly structure: AnyCallable;
  readonly capture: (input: unknown, options: Options) => unknown;
  readonly registrations: readonly ResourceRegistration[];
}

/** Static snapshot taken by a build; it contains neither this run's values nor endpoints. */
export interface ResourcePlan<Options> {
  readonly registrations: readonly ResourceRegistration[];
  readonly scopes: readonly ResourceCaptureScope<Options>[];
  readonly refinements: readonly ChildResourceBinding[];
}

type Synchronous<Value> = Value & (Value extends PromiseLike<unknown> ? never : unknown);

/** A group of selectors sharing one explicitly captured value, scoped to one structural position. */
export class CapturedResources<Snapshot> {
  constructor(private readonly registrations: ResourceRegistration[]) {}

  register<Source, Value, Captured, Selection>(offer: ResourceOffer<Source, Value, Captured, Selection>, select: (snapshot: Snapshot) => Synchronous<NoInfer<Source>>): this {
    const provider = offer.provide<unknown>((snapshot) => synchronous(select(snapshot as Snapshot), 'Resource selection'));
    addRegistration(this.registrations, Object.freeze({ offer: provider.offer, bind: () => provider }));
    return this;
  }
}

/** Resource definitions are registered with supplies; each call receives its own controlled access. */
export class Resources<Options extends object = {}> {
  readonly #registrations: ResourceRegistration[] = [];
  readonly #scopes = new Map<AnyCallable, { capture: (input: unknown, options: Options) => unknown; registrations: ResourceRegistration[] }>();
  readonly #refinements = new Map<ChildCallable, ResourceRefinement<any>[]>();

  register<Source, Value, Captured, Selection>(resource: Resource<NoInfer<Source>>, offer: ResourceOffer<Source, Value, Captured, Selection>): this;
  register<Source, Value, Captured, Selection>(offer: ResourceOffer<Source, Value, Captured, Selection>, supply: NoInfer<Source>): this;
  register<Source, Value, Captured, Selection>(resourceOrOffer: Resource<Source> | ResourceOffer<Source, Value, Captured, Selection>, offerOrSupply: ResourceOffer<Source, Value, Captured, Selection> | Source): this {
    const resource = resourceOrOffer instanceof Resource ? resourceOrOffer : undefined;
    const offer = (resource ? offerOrSupply : resourceOrOffer) as ResourceOffer<Source, Value, Captured, Selection>;
    if (!(offer instanceof ResourceOffer)) throw new TypeError('Resource registration requires an access offer');
    const supply = resource ? resource.origin : (offerOrSupply as Source);
    const provider = offer.provide<unknown>(() => supply);
    addRegistration(this.#registrations, Object.freeze({ offer: provider.offer, bind: () => provider }));
    return this;
  }

  capture<Structure extends AnyCallable, Snapshot>(structure: Structure, capture: (input: CallableInput<Structure>, options: Options) => Synchronous<Snapshot>): CapturedResources<Snapshot> {
    requireCallable(structure);
    if (this.#scopes.has(structure)) throw new Error('Duplicate resource capture scope');
    const registrations: ResourceRegistration[] = [];
    this.#scopes.set(structure, { capture: (input, options) => synchronous(capture(input as CallableInput<Structure>, options), 'Resource capture'), registrations });
    return new CapturedResources<Snapshot>(registrations);
  }

  refine<Structure extends ChildCallable>(structure: Structure, ...rules: readonly ResourceRefinement<NoInfer<CallableInput<Structure>>>[]): this {
    requireCallable(structure);
    if (structure.kind !== 'group' && structure.kind !== 'node') throw new Error('Resource refinement requires a child structure');
    const previous = this.#refinements.get(structure) ?? [];
    this.#refinements.set(structure, [...previous, ...rules]);
    return this;
  }

  /** The resource decides how it exposes interaction access; building never sends a request. */
  registerInteraction<Request, Reply, Value, Captured, Selection>(offer: ResourceOffer<InteractionChannel<Request, Reply>, Value, Captured, Selection>, contract: InteractionContract<NoInfer<Request>, NoInfer<Reply>>): this {
    const identity = offer.request().offer;
    addRegistration(
      this.#registrations,
      Object.freeze({
        offer: identity,
        bind: (interactions?: Interactions) => {
          if (!interactions) throw new Error(`Resource requires Interactions: ${identity.name}`);
          const channel = interactions.bind(contract);
          return offer.provide<unknown>(() => channel);
        },
      }),
    );
    return this;
  }

  /** Internal build input. Unrelated scene registrations remain available for another Runner. */
  snapshot(root: AnyCallable): ResourcePlan<Options> {
    const members = new Set<AnyCallable>();
    const visit = (current: AnyCallable): void => {
      if (members.has(current)) return;
      members.add(current);
      if (current.kind !== 'node') for (const member of current.members) visit(member);
    };
    visit(root);
    return Object.freeze({
      registrations: Object.freeze([...this.#registrations]),
      scopes: Object.freeze([...this.#scopes].filter(([structure]) => members.has(structure)).map(([structure, scope]) => Object.freeze({ structure, capture: scope.capture, registrations: Object.freeze([...scope.registrations]) }))),
      refinements: Object.freeze([...this.#refinements].filter(([structure]) => members.has(structure)).map(([definition, refinements]) => Object.freeze({ definition, refinements: Object.freeze([...refinements]) }))),
    });
  }
}

function requireCallable(structure: AnyCallable): void {
  if (!(structure instanceof Callable)) throw new TypeError('Resource scope requires a callable structure');
}

function addRegistration(registrations: ResourceRegistration[], registration: ResourceRegistration): void {
  if (registrations.some((entry) => entry.offer === registration.offer)) throw new Error(`Duplicate resource registration: ${registration.offer.name}`);
  registrations.push(registration);
}

function synchronous<Value>(value: Value, label: string): Value {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError(`${label} must be synchronous`);
  }
  return value;
}
