import { randomUUID } from 'node:crypto';
import { Initializer } from './internal/initializer.js';
import { applyResourceRefinement, isResourceRefinement, type ResourceRefinement } from './offer.js';
import type { ResourceEndpointDefinition, ResourceProvider } from './provider.js';
import { resourceRequests, type ResourceIdentity, type ResourceRequirements } from './request.js';

/** One supplied material. Endpoint construction remains owned by its offer. */
export interface ResourceSupplyEntry {
  readonly offer: ResourceEndpointDefinition;
  readonly supplyId: string;
  readMaterial(): unknown;
}

/** Fixed materials for one subtree. Contains no endpoint, phase or invocation owner. */
export class ResourceSupply {
  readonly entries: readonly ResourceSupplyEntry[];

  constructor(entries: readonly ResourceSupplyEntry[] = []) {
    const offers = new Set<object>();
    for (const entry of entries) {
      if (offers.has(entry.offer)) throw new Error(`Ambiguous resource supply: ${entry.offer.name}`);
      offers.add(entry.offer);
    }
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  /** Material initialization belongs to this supply, so phase windows can share it. */
  static capture<Source>(providers: readonly ResourceProvider<Source>[], source: Source): ResourceSupply {
    const offers = new Set<ResourceIdentity>();
    for (const provider of providers) {
      if (offers.has(provider.offer)) throw new Error(`Ambiguous resource supply: ${provider.offer.name}`);
      if (typeof provider.readMaterial !== 'function') throw new TypeError('Resource provider requires material selection');
      offers.add(provider.offer);
    }
    const entries = providers.map((provider): ResourceSupplyEntry => {
      const readMaterial = provider.readMaterial.bind(provider);
      const material = new Initializer(() => readMaterial(source));
      if (provider.offer.timing === 'binding') material.get();
      return Object.freeze({ offer: provider.offer, supplyId: randomUUID(), readMaterial: () => material.get() });
    });
    return new ResourceSupply(entries);
  }

  require(offer: ResourceIdentity): ResourceSupplyEntry {
    const entry = this.entries.find((candidate) => candidate.offer === offer);
    if (!entry) throw new Error(`Unfulfilled resource request: ${offer.name}`);
    return entry;
  }

  select(deps: ResourceRequirements): ResourceSupply {
    const entries: ResourceSupplyEntry[] = [];
    for (const request of resourceRequests(deps)) {
      const entry = this.require(request.offer);
      if (!entries.includes(entry)) entries.push(entry);
    }
    return new ResourceSupply(entries);
  }

  /** Only explicitly registered local supplies replace their inherited counterparts. */
  overlay(local: ResourceSupply): ResourceSupply {
    const replaced = new Set(local.entries.map((entry) => entry.offer));
    return new ResourceSupply([...this.entries.filter((entry) => !replaced.has(entry.offer)), ...local.entries]);
  }

  refine<Input>(input: Input, rules: readonly ResourceRefinement<Input>[]): ResourceSupply {
    const refinements = new Map<ResourceIdentity, ResourceRefinement<Input>>();
    for (const rule of rules) {
      if (!isResourceRefinement(rule)) throw new Error('Resource refinement was not issued by an offer');
      if (!this.entries.some((entry) => entry.offer === rule.offer)) throw new Error(`Refined resource is not requested: ${rule.offer.name}`);
      if (refinements.has(rule.offer)) throw new Error(`Duplicate resource refinement: ${rule.offer.name}`);
      refinements.set(rule.offer, rule);
    }
    return new ResourceSupply(
      this.entries.map((entry) => {
        const rule = refinements.get(entry.offer);
        if (!rule) return entry;
        const material = applyResourceRefinement(rule, entry.offer, entry.readMaterial(), input);
        return Object.freeze({ offer: entry.offer, supplyId: randomUUID(), readMaterial: () => material });
      }),
    );
  }
}
