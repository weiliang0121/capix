import { InvocationContext, type InvocationControls } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContextBuilder } from './runtime/builder.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { ExecutionInvocationBindings } from '../execution/execution.js';
import { requireNotCancelled } from '../invocation/cancellation.js';

/** Per-call construction access; only internal E construction can use these bindings. */
export interface ExecutionBindingResolver {
  get(definition: ExecutionDefinition<any, any, any, any, any, any, any>): ExecutionInvocationBindings<any, any, any, any, any>;
}

export class RuntimeContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  readonly level = 'runtime' as const;
  readonly signal: AbortSignal;
  readonly #contextBuilder?: RuntimeContextBuilder;
  readonly #executionBindings?: ExecutionBindingResolver;

  constructor(
    input: Input,
    controls: InvocationControls = {},
    contextBuilder?: RuntimeContextBuilder,
    readonly resources: ResourceBindings<Resources> = new ResourceBindings({} as ResourceRequirements<Resources>),
    executionBindings?: ExecutionBindingResolver,
  ) {
    super(input);
    this.signal = controls.signal ?? new AbortController().signal;
    this.#contextBuilder = contextBuilder;
    this.#executionBindings = executionBindings;
    Object.freeze(this);
  }

  belongsTo(contextBuilder: RuntimeContextBuilder): boolean {
    return !this.#contextBuilder || this.#contextBuilder === contextBuilder;
  }
  requireActive(): void {
    this.requireRunning();
    requireNotCancelled(this.signal);
  }
  executionBinding(definition: ExecutionDefinition<any, any, any, any, any, any, any>): ExecutionInvocationBindings<any, any, any, any, any> {
    this.requireActive();
    if (!this.#executionBindings) throw new Error('Runtime call has no execution construction binding');
    return this.#executionBindings.get(definition);
  }
}
