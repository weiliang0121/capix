import type { ResourceProvider } from '../resource/offer.js';
import type { CallableInput } from '../definition/signature.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import { collectObservationProvides, type ChildResourceBinding } from './resources.js';
import { resolveDeclaration, type ResolvedCallable, type AnyCallable } from './declarations.js';
import { bindCallableSources, type CallableCallSource, type CallableSourceBinding, type CallableSources } from './sources.js';

export interface CallableBindingOptions<Input, Options, Source> {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: CallableCallSource<Input, Options, Source>;
  readonly bindings?: readonly CallableSourceBinding<Options, Source>[];
  readonly childResources?: readonly ChildResourceBinding[];
}

/** Fixed declaration and resource wiring, without a second structural identity. */
export interface CallableBindings<Structure extends AnyCallable, Options> {
  readonly root: ResolvedCallable<Structure>;
  readonly sources: CallableSources<Options>;
}

/** Resolve static contracts and source routes; no runtime state or endpoints are captured. */
export class CallableBinder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  bind<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): CallableBindings<Structure, Options> {
    const bindings = Object.freeze([...(options.bindings ?? [])]);
    const resolved = resolveDeclaration(structure, {
      observationProvides: collectObservationProvides(this.capabilities.observations),
      observations: this.capabilities.observations,
      childResources: options.childResources,
      sources: bindings.filter((binding) => !!binding.capture).map((binding) => binding.definition),
    });
    const sources = bindCallableSources(resolved, options.providers, options.source, bindings);
    return Object.freeze({ root: resolved, sources });
  }
}
