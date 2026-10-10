import { definitionResources, observationResources } from './resources.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { InvocationControls } from '../context/context.js';
import type { ExecutionInvocationCallbacks } from '../execution/execution.js';
import type { ResourceProvider } from '../resource/offer.js';
import { bindResources, ResourceBindings, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import { createBoundRuntime, type BoundRuntimeOptions } from '../runtime/create.js';
import type { ProgressReceiver } from '../progress/channel.js';
import type { InvocationProgress } from '../invocation/progress.js';

type AnyExecutionDefinition = ExecutionDefinition<any, any, any, any, any, any>;

/** Capture per-call inputs and resources from independent supplies at entry and call boundaries. */
export interface RuntimeCallSource<Input, Options, Source> {
  validate?(options: Options): void;
  runtime?(input: Input, options: Options): Source;
  entry(input: unknown, options: Options, definition: AnyExecutionDefinition): Source;
  capture(input: unknown, options: Options, definition: AnyExecutionDefinition): Source;
  callbacks?(definition: AnyExecutionDefinition, options: Options): ExecutionInvocationCallbacks<any, any, any> | undefined;
  progress?(definition: AnyExecutionDefinition, options: Options): ProgressReceiver<InvocationProgress> | undefined;
}

/** Supplies and per-call capture functions used to bind one reusable RuntimeDefinition. */
export interface RuntimeAssemblyOptions<Input, Options, Source> extends BoundRuntimeOptions {
  readonly providers: readonly ResourceProvider<Source>[];
  readonly source: RuntimeCallSource<Input, Options, Source>;
}

/** Assemble the reusable R business endpoint from declarations and independent resource supplies. */
export function assembleRuntime<Input, Output, Resources extends object, Options extends InvocationControls, Source>(definition: RuntimeDefinition<Input, Output, Resources, any>, options: RuntimeAssemblyOptions<Input, Options, Source>) {
  const source = options.source;
  for (const observation of options.observations ?? []) observation.check?.(definition);
  const localObservationResources = observationResources(options.observations);
  const requires = definitionResources(definition, localObservationResources) as ResourceRequirements<Resources>;
  const runtimeResources = bindResources(requires, options.providers);
  if (resourceRequests(requires).length && !source.runtime) throw new Error('Runtime resource requests require a runtime source');
  const executionBindings = new Map(
    definition.children.map((executionDefinition) => [
      executionDefinition,
      {
        entry: bindResources(executionDefinition.entry?.requires ?? {}, options.providers),
        capture: bindResources(definitionResources(executionDefinition, localObservationResources), options.providers),
      },
    ]),
  );
  return createBoundRuntime<Input, Output, Options, Resources>(options, (runtime) => ({
    definition,
    children: runtime.environment.children(requires, definition.children, 'runtime', definition),
    validate: source.validate?.bind(source),
    resources: (input, callOptions) => (source.runtime ? runtimeResources(source.runtime(input, callOptions)) : new ResourceBindings<Resources>({} as ResourceRequirements<Resources>)),
    executionBindings: (_input, callOptions) => ({
      get(executionDefinition) {
        const resourceBindings = executionBindings.get(executionDefinition);
        if (!resourceBindings) throw new Error('Execution definition is not declared by this Runtime');
        return {
          entry: (input) => resourceBindings.entry(source.entry(input, callOptions, executionDefinition)),
          capture: (input) => resourceBindings.capture(source.capture(input, callOptions, executionDefinition)),
          callbacks: source.callbacks?.(executionDefinition, callOptions),
          progress: source.progress?.(executionDefinition, callOptions),
        };
      },
    }),
  }));
}
