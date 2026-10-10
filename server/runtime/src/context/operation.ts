import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { ExecutionContext } from './execution.js';
import type { ExecutionContextBuilder } from './execution/builder.js';
import { InvocationContext } from './context.js';

export class OperationContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'operation' {
    return 'operation';
  }
  readonly signal: AbortSignal;
  readonly #parentContext: ExecutionContext | OperationContext;

  constructor(
    parentContext: ExecutionContext | OperationContext,
    input: Input,
    readonly resources: ResourceBindings<Resources> = new ResourceBindings({} as ResourceRequirements<Resources>),
  ) {
    super(input);
    this.#parentContext = parentContext;
    this.signal = parentContext.signal;
    Object.freeze(this);
  }

  belongsTo(executionContextBuilder: ExecutionContextBuilder): boolean {
    return this.#parentContext.belongsTo(executionContextBuilder);
  }

  requireActive(): void {
    this.requireRunning();
    this.#parentContext.requireActive();
  }
}
