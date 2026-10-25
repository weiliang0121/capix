import type { ResourceProvider } from '@capix/resources';
import type { CallableInput } from '../definition/signature.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import { collectObservationProvides, type ChildResourceBinding } from './resources.js';
import { resolveDeclaration, type ResolvedCallable, type AnyCallable } from './declarations.js';
import { bindCallableSources, type CallableCallSource, type CallableSourceBinding } from './sources.js';
import { CallableCalls, type CallInstallation, type CallableCallsOptions } from './calls.js';
import { bindCallableHooks } from './hooks.js';
import type { Resources } from '../resource/resources.js';
import { ResourceInstallation } from '../resource/installation.js';
import type { Interactions } from '../interaction/interactions.js';

export interface CallableBindingOptions<Input, Options, Source> {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: CallableCallSource<Input, Options, Source>;
  readonly bindings?: readonly CallableSourceBinding<Options, Source>[];
  readonly childResources?: readonly ChildResourceBinding[];
}

/** Fixed declaration and resource wiring, without a second structural identity. */
export interface CallableBindings<Structure extends AnyCallable, Options> {
  readonly root: ResolvedCallable<Structure>;
  readonly calls: CallInstallation<Options>;
}

/** Resolve static contracts and source routes; no runtime state or endpoints are captured. */
export class CallableBinder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  bindResources<Structure extends AnyCallable, Options extends object>(structure: Structure, resources: Resources<Options>, interactions?: Interactions, options: CallableCallsOptions<Options> = {}): CallableBindings<Structure, Options> {
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

  bind<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): CallableBindings<Structure, Options> {
    const bindings = Object.freeze([...(options.bindings ?? [])]);
    const resolved = resolveDeclaration(structure, {
      observationProvides: collectObservationProvides(this.capabilities.observations),
      observations: this.capabilities.observations,
      childResources: options.childResources,
      sources: bindings.filter((binding) => !!binding.capture).map((binding) => binding.definition),
    });
    const calls = bindCallableSources(resolved, options.providers, options.source, bindings);
    return Object.freeze({ root: resolved, calls });
  }
}
