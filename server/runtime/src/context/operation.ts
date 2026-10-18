import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { ExecutionContext } from './execution.js';
import type { ExecutionContextBuilder } from './builders/execution.js';
import { InvocationContext } from './context.js';
import { requireNotCancelled } from '../invocation/cancellation.js';

export class OperationContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'operation' {
    return 'operation';
  }
  readonly signal: AbortSignal;
  readonly #constructionOwner?: ExecutionContextBuilder;

  constructor(
    parentContext: ExecutionContext | OperationContext,
    input: Input,
    readonly resources: ResourceBindings<Resources> = new ResourceBindings({} as ResourceRequirements<Resources>),
  ) {
    super(input);
    this.#constructionOwner = parentContext.constructionOwner;
    this.signal = parentContext.signal;
    Object.freeze(this);
  }

  belongsTo(executionContextBuilder: ExecutionContextBuilder): boolean {
    return !this.#constructionOwner || this.#constructionOwner === executionContextBuilder;
  }

  get constructionOwner(): ExecutionContextBuilder | undefined {
    return this.#constructionOwner;
  }

  requireActive(): void {
    this.requireRunning();
    requireNotCancelled(this.signal);
  }
}
