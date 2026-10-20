import type { CallableContext } from '../context/callable.js';
import type { ResourceProvider } from '../resource/offer.js';
import type { CallableInput, CallableOutput } from '../definition/signature.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import { CallableInvocationBuilder } from '../invocation/builders/callable.js';
import { BoundCallable } from '../structure/bound.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { collectObservationProvides, type ChildResourceBinding } from './resources.js';
import { BoundChildren } from './children/bound.js';
import { InvocationWorkBinding } from './work.js';
import { resolveDeclaration, type ResolvedCallable, type AnyCallable } from './declarations.js';
import { bindCallableSources, type CallableCallSource, type CallableSourceBinding } from './sources.js';

export interface CallableBindingOptions<Input, Options, Source> {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: CallableCallSource<Input, Options, Source>;
  readonly bindings?: readonly CallableSourceBinding<Options, Source>[];
  readonly childResources?: readonly ChildResourceBinding[];
}

/** Resolve once, then lazily bind members using the same callable path. */
export class CallableBinder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  bind<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): BoundCallable<CallableInput<Structure>, CallableOutput<Structure>, object, Options> {
    const bindings = Object.freeze([...(options.bindings ?? [])]);
    const resolved = resolveDeclaration(structure, {
      observationProvides: collectObservationProvides(this.capabilities.observations),
      observations: this.capabilities.observations,
      childResources: options.childResources,
      sources: bindings.filter((binding) => !!binding.capture).map((binding) => binding.definition),
    });
    const sources = bindCallableSources(resolved, options.providers, options.source, bindings);
    const invocations = new CallableInvocationBuilder(this.capabilities);
    const bindResolved = (node: ResolvedCallable): BoundCallable<any, any, any, Options> => {
      const children = new BoundChildren(node.members, bindResolved);
      const composite = 'members' in node.declaration && node.declaration.members !== undefined;
      const work = new InvocationWorkBinding<any, any, CallableContext<any, any, any>, any, any, any>(node.declaration, children, composite);
      return new BoundCallable(
        invocations,
        {
          definition: node.definition,
          declaration: node.declaration,
          children,
          composite,
          requires: node.requires as ResourceRequirements<any>,
          supply: node.supply,
          refinements: node.refinements,
          work,
        },
        sources,
      );
    };
    return bindResolved(resolved);
  }
}
