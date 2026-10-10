import type { ExecutionContextBuilder } from './execution/builder.js';
import { InvocationContext, type InvocationControls } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContext } from './runtime.js';

export class ExecutionContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'execution' {
    return 'execution';
  }
  readonly signal: AbortSignal;
  readonly resources: ResourceBindings<Resources>;
  readonly #contextBuilder?: ExecutionContextBuilder;
  readonly #parentContext?: RuntimeContext;

  constructor(input: Input, controls: InvocationControls = {}, contextBuilder?: ExecutionContextBuilder, resources?: ResourceBindings<Resources>, parentContext?: RuntimeContext) {
    super(input);
    this.#contextBuilder = contextBuilder;
    this.#parentContext = parentContext;
    this.signal = parentContext?.signal ?? controls.signal ?? new AbortController().signal;
    this.resources = resources ?? new ResourceBindings({} as ResourceRequirements<Resources>);
    Object.freeze(this);
  }

  belongsTo(contextBuilder: ExecutionContextBuilder): boolean {
    return !this.#contextBuilder || this.#contextBuilder === contextBuilder;
  }
  requireActive(): void {
    this.requireRunning();
    this.#parentContext?.requireActive();
  }
}
