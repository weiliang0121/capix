import type { InvocationCapabilities } from '../construction/capabilities.js';
import { collectObservationProvides } from './resources.js';
import { resolveDeclaration, type ResolvedCallable, type AnyCallable } from './declarations.js';
import { CallableCalls, type CallInstallation, type CallableCallsOptions } from './calls.js';
import { bindCallableHooks } from './hooks.js';
import type { Resources } from '../resource/resources.js';
import { ResourceInstallation } from '../resource/installation.js';
import type { Interactions } from '@capix/interaction';

/** Static resolution and call wiring, consumed by the atomic structure installer. */
export interface CallableBuildPlan<Structure extends AnyCallable, Options> {
  readonly root: ResolvedCallable<Structure>;
  readonly calls: CallInstallation<Options>;
}

/** Resolve declarations and resource routes; capture no current values or endpoints. */
export class CallableBinder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  bind<Structure extends AnyCallable, Options extends object>(structure: Structure, resources: Resources<Options>, interactions?: Interactions, options: CallableCallsOptions<Options> = {}): CallableBuildPlan<Structure, Options> {
    const plan = resources.snapshot(structure);
    const root = resolveDeclaration(structure, {
      observationProvides: collectObservationProvides(this.capabilities.observations),
      observations: this.capabilities.observations,
      childResources: plan.refinements,
      resourceScopes: new Map(plan.scopes.map((scope) => [scope.structure, scope.registrations.map((entry) => entry.offer)])),
    });
    const supply = new ResourceInstallation(root, plan, interactions);
    const hooks = bindCallableHooks(root, options.hooks ?? []);
    return Object.freeze({ root, calls: new CallableCalls(supply, hooks, options.validate?.bind(options)) });
  }
}
