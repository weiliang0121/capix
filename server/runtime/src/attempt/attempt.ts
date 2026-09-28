import { AttemptRecordHelper } from '../records/attempt/helper.js';
import { Invocation } from '../invocation/invocation.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import { AttemptContext } from '../context/attempt.js';
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
    const recording = this.runtime.recording ? AttemptRecordHelper.recording(this.runtime.recording, this) : undefined;
    return new Invocation<I, O, AttemptContext<I, O>>(
      () => {
        operation.requireRunning();
        operation.executionContext.requireRunning();
        if (operation.executionContext.runtime && operation.executionContext.runtime !== this.runtime) throw new Error('Call belongs to another Runtime');
        return new AttemptContext<I, O>(operation, input);
      },
      { execute: (context) => this.execute(context), receive: this.receive === Attempt.prototype.receive ? undefined : (context, result) => this.receive(context, result), maxRounds: this.maxRounds },
      operation.executionContext.signal,
      recording,
    ).run();
  }

  protected abstract execute(context: AttemptContext<I, O>): O | Promise<O>;
}
