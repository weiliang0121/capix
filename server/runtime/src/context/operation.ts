import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { ExecutionContext } from './execution.js';
import type { ExecutionContextBuilder } from './execution/builder.js';
import { InvocationContext } from './context.js';

export class OperationContext<I = unknown, O = unknown, R extends object = object> extends InvocationContext<I, O> {
  readonly signal: AbortSignal;
  readonly #parent: ExecutionContext | OperationContext;

  constructor(
    parent: ExecutionContext | OperationContext,
    input: I,
    readonly resources: ResourceBindings<R> = new ResourceBindings({} as ResourceRequirements<R>),
  ) {
    super(input);
    this.#parent = parent;
    this.signal = parent.signal;
    Object.freeze(this);
  }

  belongsTo(builder: ExecutionContextBuilder): boolean {
    return this.#parent.belongsTo(builder);
  }

  requireActive(): void {
    this.requireRunning();
    this.#parent.requireActive();
  }
}
