import { isFunction } from 'es-toolkit/predicate';
import { Execution } from '../execution/execution.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { RuntimeDefinition, ExecutionDefinitions } from '../definition/runtime.js';
import type { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';
import type { ExecutionOptions } from '../context/execution.js';
import type { ExecutionRecordMetadata } from '../records/execution/helper.js';
import { bindResources } from '../resource/bindings.js';
import type { BindingEnvironment } from './environment.js';
import { ExecutionBinding } from './execution.js';

type Input<D> = D extends ExecutionDefinition<infer I, any, any> ? I : never;
type BoundExecution<D, P extends ExecutionOptions> = D extends ExecutionDefinition<infer I, infer O, infer R> ? ExecutionBinding<I, O, R, P> : never;

/** Capture is application binding logic, separate from the reusable business definition. */
export interface ExecutionSource<I, P, S> {
  validate?(options: P): void;
  capture(input: I, options: P): { source: S; record?: ExecutionRecordMetadata };
}

/** Bound to one Runtime; captures no current input, signal, or resource snapshot. */
export class RuntimeBinding<S, E extends ExecutionDefinitions> {
  constructor(
    readonly definition: RuntimeDefinition<S, E>,
    private readonly environment: BindingEnvironment,
    private readonly invocations: ExecutionInvocationBuilder,
  ) {}
  execution<K extends keyof E, P extends ExecutionOptions>(key: K, source: ExecutionSource<Input<E[K]>, P, S>): BoundExecution<E[K], P> {
    const definition = this.definition.executions[key];
    if (!definition || definition.level !== 'execution' || !isFunction(definition.execute)) throw new Error('Execution is not declared in this runtime binding');
    const children = this.environment.children(definition.requires, definition.children, 'execution');
    const resources = bindResources(definition.requires, this.definition.providers);
    return new ExecutionBinding(
      new Execution(this.invocations),
      definition,
      children,
      (input, options: P) => {
        const captured = source.capture(input, options);
        return { resources: resources(captured.source), record: captured.record };
      },
      source.validate?.bind(source),
    ) as BoundExecution<E[K], P>;
  }
}
