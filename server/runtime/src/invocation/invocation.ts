import type { InvocationContext } from '../context/context.js';
import type { InvocationRecording } from './recording.js';
import { writeRecord } from '../records/error.js';
import { cycle, type InvocationWork } from './cycle.js';

export interface InvocationOptions<I, O, C extends InvocationContext<I, O>> {
  context: C;
  work: InvocationWork<C, I, O>;
  signal: AbortSignal;
  recording?: InvocationRecording<C>;
  started?: (context: C) => void;
  validate?: () => void;
}

/** A single-use structured call. Context, progress and records belong to this invocation, not the behavior instance. */
export class Invocation<I, O, C extends InvocationContext<I, O>> {
  #started = false;

  constructor(private readonly options: InvocationOptions<I, O, C>) {}

  get context(): C {
    return this.options.context;
  }

  async run(): Promise<O> {
    if (this.#started) throw new Error('Invocation has already started');
    this.#started = true;
    const context = this.context;
    context.requireRunning();
    try {
      this.options.validate?.();
      writeRecord(() => {
        this.options.started?.(context);
        this.options.recording?.begin(context);
      });
    } catch (error) {
      context.fail(error);
      throw error;
    }

    let output: O;
    try {
      output = await cycle(context, this.options.work, this.options.signal, (process) => writeRecord(() => this.options.recording?.process(context, process)));
    } catch (error) {
      context.fail(error);
      try {
        writeRecord(() => this.options.recording?.finish(context));
      } catch (registrationError) {
        throw new AggregateError([error, registrationError], 'Work failed and failure registration also failed', { cause: error });
      }
      throw error;
    }
    // Registration failure after success must not fail or repeat the completed work.
    context.complete(output);
    writeRecord(() => this.options.recording?.finish(context));
    return output;
  }
}
