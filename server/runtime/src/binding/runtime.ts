import { definitionResources, observationResources } from '../definition/invocation.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { RuntimeCallOptions } from '../context/runtime.js';
import type { ExecutionCallbacks } from '../execution/execution.js';
import type { ResourceProvider } from '../resource/offer.js';
import { bindResources, ResourceBindings, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import { createRuntime, type RuntimeCreationOptions } from '../runtime/create.js';

/** Application binding fixes values from independent supplies at explicit entry and call boundaries. */
type AnyExecution = ExecutionDefinition<any, any, any, any, any, any>;

export interface RuntimeSource<I, P, S> {
  validate?(options: P): void;
  runtime?(input: I, options: P): S;
  entry(input: unknown, options: P, definition: AnyExecution): S;
  capture(input: unknown, options: P, definition: AnyExecution): S;
  callbacks?(definition: AnyExecution, options: P): ExecutionCallbacks<any, any, any> | undefined;
}

export interface RuntimeAssembly<I, P, S> extends RuntimeCreationOptions {
  readonly providers: readonly ResourceProvider<S>[];
  readonly source: RuntimeSource<I, P, S>;
}

/** The only assembly entry produces an R business endpoint; it does not create resource entities. */
export function assembleRuntime<I, O, R extends object, P extends RuntimeCallOptions, S>(definition: RuntimeDefinition<I, O, R, any>, options: RuntimeAssembly<I, P, S>) {
  const source = options.source;
  for (const observation of options.observations ?? []) observation.check?.(definition);
  const localObservationResources = observationResources(options.observations);
  const requires = definitionResources(definition, localObservationResources) as ResourceRequirements<R>;
  const runtimeResources = bindResources(requires, options.providers);
  if (resourceRequests(requires).length && !source.runtime) throw new Error('Runtime resource requests require a runtime source');
  const executions = new Map(
    definition.children.map((execution) => [
      execution,
      {
        entry: bindResources(execution.entry?.requires ?? {}, options.providers),
        capture: bindResources(definitionResources(execution, localObservationResources), options.providers),
      },
    ]),
  );
  return createRuntime<I, O, P, R>(options, (runtime) => ({
    definition,
    children: runtime.environment.children(requires, definition.children, 'runtime', definition),
    validate: source.validate?.bind(source),
    resources: (input, parameters) => (source.runtime ? runtimeResources(source.runtime(input, parameters)) : new ResourceBindings<R>({} as ResourceRequirements<R>)),
    executions: (_input, parameters) => ({
      get(execution) {
        const bound = executions.get(execution);
        if (!bound) throw new Error('Execution definition is not declared by this Runtime');
        return {
          entry: (input) => bound.entry(source.entry(input, parameters, execution)),
          capture: (input) => bound.capture(source.capture(input, parameters, execution)),
          callbacks: source.callbacks?.(execution, parameters),
        };
      },
    }),
  }));
}
