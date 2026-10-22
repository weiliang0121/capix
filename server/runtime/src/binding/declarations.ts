import type { CallableKind } from '@capix/protocol';
import { isFunction } from 'es-toolkit/predicate';
import type { ChildCallable } from '../definition/children.js';
import type { Scene } from '../structure/scene.js';
import { resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import { isResourceRefinement, type ResourceRefinement } from '../resource/offer.js';
import type { ChildBindingOptions } from './contract.js';
import { collectDefinitionRequirements, collectResourceSupply, type ChildResourceBinding } from './resources.js';
import { childKinds } from '../definition/kind.js';
import { originalReception, snapshotDefinition, type CallableSnapshot } from './snapshot.js';

export type AnyCallable = Scene<any, any, any, any, any> | ChildCallable;

/** Fixed interpretation of one structural position, without values or call state. */
export interface ResolvedCallable<Definition extends AnyCallable = AnyCallable> {
  readonly kind: Definition['kind'];
  readonly definition: Definition;
  readonly declaration: CallableSnapshot;
  readonly requires: ResourceRequirements;
  /** Offers routed through this position; local Work still receives only local requests. */
  readonly supply: ResourceRequirements;
  readonly members: readonly ResolvedChild[];
  readonly refinements?: readonly ResourceRefinement<any>[];
}
export type ResolvedChild = ResolvedCallable<ChildCallable>;

/** All dependency collection is static. Explicit source bindings delimit supply, never callable kind. */
export function resolveDeclaration<Definition extends AnyCallable>(definition: Definition, options: ChildBindingOptions = {}): ResolvedCallable<Definition> {
  const refinements = new Map<AnyCallable, readonly ResourceRefinement<any>[]>();
  for (const binding of options.childResources ?? []) {
    if (refinements.has(binding.definition)) throw new Error('Duplicate child resource binding');
    refinements.set(binding.definition, Object.freeze([...binding.refinements]));
  }
  const captures = new Set(options.sources ?? []);
  const encountered = new Set<AnyCallable>();
  const path = new Set<AnyCallable>();
  const observations: { definition: AnyCallable; parent?: AnyCallable }[] = [];
  const visit = (current: AnyCallable, parent?: { readonly kind: CallableKind; readonly definition: AnyCallable }): ResolvedCallable => {
    if (path.has(current)) throw new Error('Cyclic member declaration');
    if (!isFunction(current.run?.execute)) throw new Error('Callable definition requires execute');
    const allowed: readonly CallableKind[] | undefined = parent && childKinds[parent.kind];
    if (!Object.hasOwn(childKinds, current.kind) || (allowed && !allowed.includes(current.kind))) throw new Error('Invalid member definition kind');
    const declaration = snapshotDefinition(current);
    observations.push({ definition: current, parent: parent?.definition });
    const requires = collectDefinitionRequirements(declaration, options.observationProvides);
    const definitions: readonly ChildCallable[] = 'members' in declaration ? (declaration.members ?? []) : [];
    const receptions = new Set<object>();
    for (const reception of declaration.receptions ?? []) {
      const original = originalReception(reception);
      if (receptions.has(original)) throw new Error('Duplicate parent reception contract');
      receptions.add(original);
      if (!definitions.some((member) => member === reception.child)) throw new Error('Reception targets a member outside its owner');
    }
    const points = declaration.checkpoint?.points ?? [];
    const names = new Set<string>();
    for (const point of points) {
      if (!point.name || names.has(point.name)) throw new Error('Checkpoint points need distinct registered names');
      names.add(point.name);
      for (const slot of Object.values(point.references as import('../definition/checkpoint.js').CheckpointReferenceSlots)) {
        if (!definitions.some((member) => member === slot.definition)) throw new Error('Checkpoint reference targets a member outside its owner');
      }
    }
    const checkpointUses = points.flatMap((point) => [...(point.resume.uses ?? [])]);
    for (const child of [...(declaration.run.uses ?? definitions), ...(declaration.exceptions?.uses ?? []), ...checkpointUses]) {
      if (!definitions.some((member) => member === child)) throw new Error('Declaration uses a member outside its owner');
    }
    const selected = refinements.get(current);
    const node = { kind: declaration.kind, definition: current, declaration, requires, refinements: selected };
    encountered.add(current);
    path.add(current);
    const members = definitions.map((member) => visit(member, node) as ResolvedChild);
    path.delete(current);
    const inherited = members.filter((member) => !captures.has(member.definition)).map((member) => member.supply);
    const supply = collectResourceSupply([requires, ...inherited]);
    if (selected) checkRefinements(supply, selected);
    return Object.freeze({ ...node, supply, members: Object.freeze(members) });
  };
  const resolved = visit(definition);
  for (const binding of options.childResources ?? []) {
    if (!encountered.has(binding.definition)) throw new Error('Resource refinement requires a registered member');
  }
  for (const target of captures) {
    if (!encountered.has(target)) throw new Error('Call source requires a registered member');
  }
  // Fix every interpreted entry before host checks run; checks cannot rewrite a later member's work.
  for (const entry of observations) {
    for (const observation of options.observations ?? []) observation.check?.(entry.definition, entry.parent);
  }
  // Traversal preserves the identity and kind of its exact root definition.
  return resolved as ResolvedCallable<Definition>;
}

function checkRefinements(supply: ResourceRequirements, refinements: ChildResourceBinding['refinements']): void {
  const offers = new Set(resourceRequests(supply).map((request) => request.offer));
  const seen = new Set<ResourceRefinement<any>['offer']>();
  for (const refinement of refinements) {
    if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
    if (!offers.has(refinement.offer)) throw new Error(`Refined resource is not requested: ${refinement.offer.name}`);
    if (seen.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
    seen.add(refinement.offer);
  }
}
