import { ExecutionRecordHelper } from '../records/execution/helper.js';
import { Invocation } from '../invocation/invocation.js';
import { receiveResult, type Continuation, type InvocationResult } from '../invocation/result.js';
import { ExecutionContext, type ExecutionOptions } from '../context/execution.js';
import type { Runtime } from '../runtime/runtime.js';

/** Reusable execution behavior. Input acceptance and invocation run inside the Runtime reservation. */
export abstract class Execution<I, O> {
  protected readonly maxRounds: 1 | 2 = 1;
  constructor(protected readonly runtime: Runtime) {}

  protected receive(_context: ExecutionContext<I, O>, result: InvocationResult<O>): O | Continuation<I> | Promise<O | Continuation<I>> {
    return receiveResult(result);
  }

  call(input: I, options: ExecutionOptions, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return this.submit(() => input, options, started);
  }

  submit(accept: () => I, options: ExecutionOptions, started?: (context: ExecutionContext<I, O>) => void): Promise<O> {
    return this.runtime.run(() => {
      if (options.transcript && options.transcript !== this.runtime.transcript) throw new Error('Execution Transcript belongs to another Runtime');
      const input = accept();
      const signal = options.signal ?? new AbortController().signal;
      const recording = this.runtime.recording ? ExecutionRecordHelper.recording(this.runtime.recording) : undefined;
      return new Invocation<I, O, ExecutionContext<I, O>>(
        () => {
          this.prepare(input, options);
          const context = new ExecutionContext<I, O>(input, { ...options, runtime: this.runtime, signal, transcript: this.runtime.transcript });
          return context;
        },
        { execute: (context) => this.execute(context), receive: this.receive === Execution.prototype.receive ? undefined : (context, result) => this.receive(context, result), maxRounds: this.maxRounds },
        signal,
        recording,
        started,
      ).run();
    });
  }

  protected prepare(_input: I, _options: ExecutionOptions): void {}
  protected abstract execute(context: ExecutionContext<I, O>): O | Promise<O>;
}
