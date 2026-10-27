import type { ResourceProvider } from '@capix/resources';
import type { CallableInput } from '@capix/contracts';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from '../construction/capabilities.js';
import { collectObservationProvides, type ChildResourceBinding } from '../binding/resources.js';
import { resolveDeclaration, type AnyCallable } from '../binding/declarations.js';
import type { CallableBuildPlan } from '../binding/callable.js';
import { bindCallableSources, type CallableCallSource, type CallableSourceBinding } from './sources.js';
import { installCallable } from '../structure/install.js';
import type { BuiltCallable } from '../structure/construction.js';

/** Legacy source-based construction; new hosts use Resources and CallableBuilder. */
export interface CallableBindingOptions<Input, Options, Source> {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: CallableCallSource<Input, Options, Source>;
  readonly bindings?: readonly CallableSourceBinding<Options, Source>[];
  readonly childResources?: readonly ChildResourceBinding[];
}

export function buildCallableFromSource<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>, capabilities: InvocationCapabilities = {}): BuiltCallable<Structure, Options> {
  const fixed = snapshotInvocationCapabilities(capabilities);
  return installCallable(structure, fixed, () => bindSource(structure, options, fixed));
}

function bindSource<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>, capabilities: InvocationCapabilities): CallableBuildPlan<Structure, Options> {
  const bindings = Object.freeze([...(options.bindings ?? [])]);
  const root = resolveDeclaration(structure, {
    observationProvides: collectObservationProvides(capabilities.observations),
    observations: capabilities.observations,
    childResources: options.childResources,
    sources: bindings.filter((binding) => !!binding.capture).map((binding) => binding.definition),
  });
  return Object.freeze({ root, calls: bindCallableSources(root, options.providers, options.source, bindings) });
}
