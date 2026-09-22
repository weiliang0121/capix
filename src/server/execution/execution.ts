import { invoke } from '../invocation/invoke.js';
import type { ExecutionContext, ExecutionOptions } from '../context/execution.js';
import type { Runtime } from '../runtime/runtime.js';

/** A callable composition. Execution state belongs to a fresh Context on every call. */
export abstract class Execution<I, O> {
  constructor(protected readonly runtime: Runtime) {}

  call(input: I, options: ExecutionOptions): Promise<O> {
    return invoke(this.runtime.execution<I, O>({ ...options, input }), (context) => this.execute(context));
  }

  protected abstract execute(context: ExecutionContext<I, O>): O | Promise<O>;
}
