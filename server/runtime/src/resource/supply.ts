import { randomUUID } from 'node:crypto';
import { ResourceRequest, applyResourceRefinement, isResourceRefinement, type ResourceValue, type ResourceRefinement } from './offer.js';
import type { ResourceRequirements } from './bindings.js';

/** Fixed captures for one subtree. Contains no endpoints, phase or invocation owner. */
export class ResourceSupply {
  readonly entries: readonly ResourceValue[];

  constructor(entries: readonly ResourceValue[] = []) {
    const offers = new Set<object>();
    for (const entry of entries) {
      if (offers.has(entry.offer)) throw new Error(`Ambiguous resource supply: ${entry.offer.name}`);
      offers.add(entry.offer);
    }
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  select(requires: ResourceRequirements): ResourceSupply {
    const entries: ResourceValue[] = [];
    for (const request of Object.values(requires) as ResourceRequest<unknown>[]) {
      const entry = this.entries.find((value) => value.offer === request.offer);
      if (!entry) throw new Error(`Unfulfilled resource request: ${request.offer.name}`);
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
    const refinements = new Map<ResourceValue['offer'], ResourceRefinement<Input>>();
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
        const captured = applyResourceRefinement(rule, entry.offer, entry.capture(), input);
        return Object.freeze({ ...entry, supplyId: randomUUID(), capture: () => captured, get: () => captured });
      }),
    );
  }
}
