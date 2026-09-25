import { invoke } from '../invocation/invoke.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import type { AttemptContext } from '../context/attempt.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

/** The leaf execution boundary. Internal work uses ordinary functions, not child attempts. */
export abstract class Attempt<I, O> {
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;
  abstract readonly callee: string;

  protected readonly maxRounds: 1 | 2 = 1;

  constructor(protected readonly runtime: Runtime) {}

  protected receive(_context: AttemptContext<I, O>, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>> {
    return receiveResult(result);
  }

  call(operation: OperationContext, input: I): Promise<O> {
    return invoke(this.runtime.attempt(operation, this, input), (context) => this.runtime.run(context, { execute: (current) => this.execute(current), receive: this.receive === Attempt.prototype.receive ? undefined : (current, result) => this.receive(current, result), maxRounds: this.maxRounds }));
  }

  protected abstract execute(context: AttemptContext<I, O>): O | Promise<O>;
}
