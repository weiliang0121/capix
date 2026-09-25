import { invoke } from '../invocation/invoke.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import type { ExecutionContext, ExecutionOptions } from '../context/execution.js';
import type { Runtime } from '../runtime/runtime.js';

/** A callable composition. Execution state belongs to a fresh Context on every call. */
export abstract class Execution<I, O> {
  protected readonly maxRounds: 1 | 2 = 1;

  constructor(protected readonly runtime: Runtime) {}

  protected receive(_context: ExecutionContext<I, O>, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>> {
    return receiveResult(result);
  }

  call(input: I, options: ExecutionOptions, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return invoke(this.runtime.execution<I, O>({ ...options, input }, started), (context) => this.runtime.run(context, { execute: (current) => this.execute(current), receive: this.receive === Execution.prototype.receive ? undefined : (current, result) => this.receive(current, result), maxRounds: this.maxRounds }));
  }

  protected abstract execute(context: ExecutionContext<I, O>): O | Promise<O>;
}
