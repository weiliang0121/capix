import { randomUUID } from 'node:crypto';
import { invoke } from '../invocation/invoke.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

/** A reusable work unit. Concrete operations organize their own named attempts. */
export abstract class Operation<I, O> {
  readonly id = randomUUID();
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;

  protected readonly maxRounds: 1 | 2 = 1;

  constructor(protected readonly runtime: Runtime) {}

  protected receive(_context: OperationContext<I, O>, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>> {
    return receiveResult(result);
  }

  call(execution: ExecutionContext, input: I, parent?: OperationContext): Promise<O> {
    return invoke(this.runtime.operation(execution, this, input, parent), (context) => this.runtime.run(context, { execute: (current) => this.execute(current), receive: this.receive === Operation.prototype.receive ? undefined : (current, result) => this.receive(current, result), maxRounds: this.maxRounds }));
  }

  protected abstract execute(context: OperationContext<I, O>): O | Promise<O>;
}

export function identity<T>(value: T): T {
  return value;
}
