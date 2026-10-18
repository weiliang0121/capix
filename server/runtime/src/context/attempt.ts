import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { OperationContext } from './operation.js';
import { InvocationContext } from './context.js';
import { requireNotCancelled } from '../invocation/cancellation.js';

export class AttemptContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'attempt' {
    return 'attempt';
  }
  readonly signal: AbortSignal;

  constructor(
    parentContext: OperationContext,
    input: Input,
    readonly resources: ResourceBindings<Resources> = new ResourceBindings({} as ResourceRequirements<Resources>),
  ) {
    super(input);
    this.signal = parentContext.signal;
    Object.freeze(this);
  }

  requireActive(): void {
    this.requireRunning();
    requireNotCancelled(this.signal);
  }
}
