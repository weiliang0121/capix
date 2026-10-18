import type { ExecutionContextBuilder } from './builders/execution.js';
import { InvocationContext, type InvocationControls } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContext } from './runtime.js';
import { requireNotCancelled } from '../invocation/cancellation.js';

export class ExecutionContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  get level(): 'execution' {
    return 'execution';
  }
  readonly signal: AbortSignal;
  readonly resources: ResourceBindings<Resources>;
  readonly #constructionOwner?: ExecutionContextBuilder;

  constructor(input: Input, controls: InvocationControls = {}, contextBuilder?: ExecutionContextBuilder, resources?: ResourceBindings<Resources>, parentContext?: RuntimeContext) {
    super(input);
    this.#constructionOwner = contextBuilder;
    this.signal = parentContext?.signal ?? controls.signal ?? new AbortController().signal;
    this.resources = resources ?? new ResourceBindings({} as ResourceRequirements<Resources>);
    Object.freeze(this);
  }

  belongsTo(contextBuilder: ExecutionContextBuilder): boolean {
    return !this.#constructionOwner || this.#constructionOwner === contextBuilder;
  }
  get constructionOwner(): ExecutionContextBuilder | undefined {
    return this.#constructionOwner;
  }
  requireActive(): void {
    this.requireRunning();
    requireNotCancelled(this.signal);
  }
}
