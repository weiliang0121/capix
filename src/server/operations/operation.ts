import { randomUUID } from 'node:crypto';
import { invoke } from '../invocation/invoke.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { Runtime } from '../runtime/runtime.js';

/** A reusable work unit. Concrete operations organize their own named attempts. */
export abstract class Operation<I, O> {
  readonly id = randomUUID();
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly source: string;

  constructor(protected readonly runtime: Runtime) {}

  call(execution: ExecutionContext, input: I, parent?: OperationContext): Promise<O> {
    return invoke(this.runtime.operation(execution, this, input, parent), (context) => this.execute(context));
  }

  protected abstract execute(context: OperationContext<I, O>): O | Promise<O>;
}

export function identity<T>(value: T): T {
  return value;
}
