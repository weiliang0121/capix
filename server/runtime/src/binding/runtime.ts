import { Execution } from '../execution/execution.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { ExecutionOptions } from '../context/execution.js';
import type { ResourceProvider } from '../resource/offer.js';
import { bindResources, type ResourceRequirements } from '../resource/bindings.js';
import { createRuntime, type RuntimeCreationOptions } from '../runtime/create.js';

/** Application binding fixes values from independent supplies at explicit entry and call boundaries. */
export interface ExecutionSource<I, U, P, S> {
  validate?(options: P): void;
  entry(input: U, options: P): S;
  capture(input: I, options: P): S;
}

export interface RuntimeAssembly<I, U, P, S> extends RuntimeCreationOptions {
  readonly providers: readonly ResourceProvider<S>[];
  readonly source: ExecutionSource<I, U, P, S>;
}

/** The only assembly entry produces an R business endpoint; it does not create resource entities. */
export function assembleRuntime<I, O, R extends object, U, ER extends object, P extends ExecutionOptions, S>(definition: RuntimeDefinition<ExecutionDefinition<I, O, R, U, ER>>, options: RuntimeAssembly<I, U, P, S>) {
  const execution = definition.execution;
  const source = options.source;
  const executionResources = bindResources(execution.requires, options.providers);
  const entryResources = bindResources(execution.entry?.requires ?? ({} as ResourceRequirements<ER>), options.providers);
  return createRuntime<U, O, P>(
    options,
    (runtime) =>
      new Execution(runtime.executionInvocations, execution, runtime.environment.children(execution.requires, execution.children, 'execution'), {
        validate: source.validate?.bind(source),
        entry: (input, parameters) => entryResources(source.entry(input, parameters)),
        capture: (input, parameters) => executionResources(source.capture(input, parameters)),
      }),
  );
}
