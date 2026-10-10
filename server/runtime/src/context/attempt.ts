import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { OperationContext } from './operation.js';
import { InvocationContext } from './context.js';

export class AttemptContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'attempt' {
    return 'attempt';
  }
  readonly signal: AbortSignal;
  readonly #parentContext: OperationContext;

  constructor(
    parentContext: OperationContext,
    input: Input,
    readonly resources: ResourceBindings<Resources> = new ResourceBindings({} as ResourceRequirements<Resources>),
  ) {
    super(input);
    this.#parentContext = parentContext;
    this.signal = parentContext.signal;
    Object.freeze(this);
  }

  requireActive(): void {
    this.requireRunning();
    this.#parentContext.requireActive();
  }
}
