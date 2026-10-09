import { InvocationContext } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContextBuilder } from './runtime/builder.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { ExecutionAssembly } from '../execution/execution.js';

export interface RuntimeCallOptions {
  readonly signal?: AbortSignal;
}

/** Per-call construction access; only internal E construction can use these bindings. */
export interface RuntimeExecutionBindings {
  get(definition: ExecutionDefinition<any, any, any, any, any, any>): ExecutionAssembly<any, any, any, any, any>;
}

export class RuntimeContext<I = unknown, O = unknown, R extends object = object> extends InvocationContext<I, O> {
  readonly level = 'runtime' as const;
  readonly signal: AbortSignal;
  readonly #owner?: RuntimeContextBuilder;
  readonly #executions?: RuntimeExecutionBindings;

  constructor(
    input: I,
    options: RuntimeCallOptions = {},
    owner?: RuntimeContextBuilder,
    readonly resources: ResourceBindings<R> = new ResourceBindings({} as ResourceRequirements<R>),
    executions?: RuntimeExecutionBindings,
  ) {
    super(input);
    this.signal = options.signal ?? new AbortController().signal;
    this.#owner = owner;
    this.#executions = executions;
    Object.freeze(this);
  }

  belongsTo(builder: RuntimeContextBuilder): boolean {
    return !this.#owner || this.#owner === builder;
  }
  requireActive(): void {
    this.requireRunning();
  }
  execution(definition: ExecutionDefinition<any, any, any, any, any, any>): ExecutionAssembly<any, any, any, any, any> {
    this.requireActive();
    if (!this.#executions) throw new Error('Runtime call has no execution construction binding');
    return this.#executions.get(definition);
  }
}
