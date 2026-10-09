import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { OperationContext } from './operation.js';
import { InvocationContext } from './context.js';

export class AttemptContext<I = unknown, O = unknown, R extends object = object> extends InvocationContext<I, O> {
  get level(): 'attempt' {
    return 'attempt';
  }
  readonly signal: AbortSignal;
  readonly #parent: OperationContext;

  constructor(
    parent: OperationContext,
    input: I,
    readonly resources: ResourceBindings<R> = new ResourceBindings({} as ResourceRequirements<R>),
  ) {
    super(input);
    this.#parent = parent;
    this.signal = parent.signal;
    Object.freeze(this);
  }

  requireActive(): void {
    this.requireRunning();
    this.#parent.requireActive();
  }
}
