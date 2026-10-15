import type { RuntimeDefinition } from '../definition/runtime.js';
import type { InvocationControls } from '../context/context.js';
import type { RuntimeContext } from '../context/runtime.js';
import type { ResourceProvider } from '../resource/offer.js';
import type { InvocationCapabilities } from '../invocation/capabilities.js';
import { createInvocationBuilders } from '../invocation/builders.js';
import { BoundRuntime } from '../runtime/runtime.js';
import { bindResources, ResourceBindings, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import { checkChildResourceBindings, collectDefinitionRequirements, collectObservationProvides, type ChildResourceBinding } from './resources.js';
import { BoundChildren } from './children/bound.js';
import { bindInvocationWork } from './work.js';
import { checkChildDeclarations } from './declarations.js';
import { AttemptBinder } from './attempt.js';
import { OperationBinder } from './operation.js';
import { ExecutionBinder } from './execution.js';
import { bindExecutionSources, type RuntimeCallSource } from './sources.js';
import type { ChildBindingOptions, RuntimeBinding } from './contract.js';

export type { RuntimeCallSource } from './sources.js';

/** Independent supplies and per-call capture sources for one R declaration. */
export interface RuntimeBindingOptions<Input, Options, Source> {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: RuntimeCallSource<Input, Options, Source>;
  readonly childResources?: readonly ChildResourceBinding[];
}

export interface RuntimeAssemblyOptions<Input, Options, Source> extends RuntimeBindingOptions<Input, Options, Source>, InvocationCapabilities {}

/** Bind a complete declaration graph before establishing its R structure. */
export class RuntimeBinder {
  constructor(private readonly capabilities: InvocationCapabilities = {}) {}

  bind<Input, Output, Resources extends object, Options extends InvocationControls, Source>(definition: RuntimeDefinition<Input, Output, Resources, any, any>, options: RuntimeBindingOptions<Input, Options, Source>): BoundRuntime<Input, Output, Options, Resources> {
    const source = options.source;
    for (const observation of this.capabilities.observations ?? []) observation.check?.(definition);
    const observationProvides = collectObservationProvides(this.capabilities.observations);
    const childResources = Object.freeze([...(options.childResources ?? [])]);
    checkChildResourceBindings(definition.children, childResources, observationProvides);
    const requires = collectDefinitionRequirements(definition, observationProvides) as ResourceRequirements<Resources>;
    const runtimeResources = bindResources(requires, options.providers);
    if (resourceRequests(requires).length && !source.runtime) throw new Error('Runtime resource requests require a runtime source');
    const executionBindings = bindExecutionSources(definition.children, options.providers, source, observationProvides);

    const childOptions: ChildBindingOptions = { observationProvides, observations: this.capabilities.observations, childResources };
    checkChildDeclarations(requires, definition.children, 'runtime', childOptions, definition);
    // A reused Binder still creates an independent ownership chain for every R it binds.
    const invocations = createInvocationBuilders(this.capabilities);
    const attempts = new AttemptBinder(invocations.attempt, childOptions);
    const operations = new OperationBinder(invocations.operation, attempts, childOptions);
    const executions = new ExecutionBinder(invocations.execution, operations, childOptions);
    const children = new BoundChildren(definition.children, (child) => {
      if (child.level !== 'execution') throw new Error('Invalid child definition level');
      return executions.bind(child);
    });
    const work = bindInvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>, Resources, any>(definition, children);
    const binding: RuntimeBinding<Input, Output, Options, Resources> = {
      definition,
      children,
      requires,
      work,
      validate: source.validate?.bind(source),
      progress: source.progress?.bind(source),
      output: source.output?.bind(source),
      resources: (input, callOptions) => (source.runtime ? runtimeResources(source.runtime(input, callOptions)) : new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)),
      executionBindings,
    };
    return new BoundRuntime(invocations.runtime, binding, this.capabilities);
  }
}

/** Application convenience entry; each call binds an independent R structure. */
export function assembleRuntime<Input, Output, Resources extends object, Options extends InvocationControls, Source>(definition: RuntimeDefinition<Input, Output, Resources, any, any>, options: RuntimeAssemblyOptions<Input, Options, Source>): BoundRuntime<Input, Output, Options, Resources> {
  const binder = new RuntimeBinder(options);
  return binder.bind(definition, options);
}
