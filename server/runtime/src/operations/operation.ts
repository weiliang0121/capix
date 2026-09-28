import { OperationRecordHelper } from '../records/operation/helper.js';
import { randomUUID } from 'node:crypto';
import { Invocation } from '../invocation/invocation.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import type { ExecutionContext } from '../context/execution.js';
import { OperationContext } from '../context/operation.js';
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
    const recording = this.runtime.recording ? OperationRecordHelper.recording(this.runtime.recording, this, parent) : undefined;
    return new Invocation<I, O, OperationContext<I, O>>(
      () => {
        execution.requireRunning();
        if (execution.runtime && execution.runtime !== this.runtime) throw new Error('Call belongs to another Runtime');
        if (parent) {
          parent.requireRunning();
          if (parent.executionContext !== execution) throw new Error('Parent operation belongs to another execution');
        }
        return new OperationContext<I, O>(execution, input);
      },
      { execute: (context) => this.execute(context), receive: this.receive === Operation.prototype.receive ? undefined : (context, result) => this.receive(context, result), maxRounds: this.maxRounds },
      execution.signal,
      recording,
    ).run();
  }

  protected abstract execute(context: OperationContext<I, O>): O | Promise<O>;
}
