import { ExecutionContext, type ExecutionOptions } from '../execution.js';
import type { Transcript } from '../../transcript/transcript.js';

/** Reusable construction boundary; it never stores the current input or signal. */
export class ExecutionContextBuilder {
  constructor(private readonly transcript: Transcript) {}

  check(options: ExecutionOptions): void {
    if (options.transcript && options.transcript !== this.transcript) throw new Error('Execution Transcript belongs to another Runtime');
  }

  create<I, O>(input: I, options: ExecutionOptions): ExecutionContext<I, O> {
    this.check(options);
    return new ExecutionContext(input, { ...options, transcript: this.transcript }, this);
  }

  requireActive(context: ExecutionContext): void {
    context.requireRunning();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another Runtime');
  }
}
