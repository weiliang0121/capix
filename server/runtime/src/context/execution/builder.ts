import { ExecutionContext, type ExecutionOptions, type ExecutionResourceSource } from '../execution.js';
import type { ResourceBindings } from '../../resource/bindings.js';
import type { Transcript } from '../../transcript/transcript.js';

/** Reusable construction boundary; it never stores the current input or signal. */
export class ExecutionContextBuilder {
  constructor(private readonly transcript: Transcript) {}

  check(options: ExecutionOptions): void {
    if (options.transcript && options.transcript !== this.transcript) throw new Error('Execution Transcript belongs to another Runtime');
  }

  create<I, O, R extends object = object>(input: I, options: ExecutionOptions, bind?: (source: ExecutionResourceSource) => ResourceBindings<R>): ExecutionContext<I, O, R> {
    this.check(options);
    return new ExecutionContext(input, { ...options, transcript: this.transcript }, this, bind);
  }

  requireActive(context: ExecutionContext): void {
    context.requireRunning();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
