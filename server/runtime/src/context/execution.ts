import type { ExecutionContextBuilder } from './execution/builder.js';
import { InvocationContext } from './context.js';
import { ResourceBindings, type ResourceRequirements } from '../resource/bindings.js';
import type { RuntimeContext } from './runtime.js';

/** Per-call controls; application settings and entity selection belong to binding. */
export interface ExecutionOptions {
  signal?: AbortSignal;
}

export class ExecutionContext<I = unknown, O = unknown, R extends object = object> extends InvocationContext<I, O> {
  get level(): 'execution' {
    return 'execution';
  }
  readonly signal: AbortSignal;
  readonly resources: ResourceBindings<R>;
  readonly #owner?: ExecutionContextBuilder;
  readonly #parent?: RuntimeContext;

  constructor(input: I, options: ExecutionOptions = {}, owner?: ExecutionContextBuilder, resources?: ResourceBindings<R>, parent?: RuntimeContext) {
    super(input);
    this.#owner = owner;
    this.#parent = parent;
    this.signal = parent?.signal ?? options.signal ?? new AbortController().signal;
    this.resources = resources ?? new ResourceBindings({} as ResourceRequirements<R>);
    Object.freeze(this);
  }

  belongsTo(builder: ExecutionContextBuilder): boolean {
    return !this.#owner || this.#owner === builder;
  }
  requireActive(): void {
    this.requireRunning();
    this.#parent?.requireActive();
  }
}
