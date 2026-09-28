import type { InvocationContext } from '../context/context.js';
import type { RuntimeRecorder } from '../records/recorder.js';
import { writeRecord } from '../records/error.js';
import { cycle, type InvocationWork } from './cycle.js';

/** A single-use structured call. Context, progress and records belong to this invocation, not the behavior instance. */
export class Invocation<I, O, C extends InvocationContext<I, O>> {
  #started = false;
  #context?: C;

  constructor(
    private readonly prepare: () => C,
    private readonly work: InvocationWork<C, I, O>,
    private readonly signal: AbortSignal,
    private readonly recorder?: RuntimeRecorder,
    private readonly register: (context: C) => void = () => {},
  ) {}

  get context(): C | undefined {
    return this.#context;
  }

  async run(): Promise<O> {
    if (this.#started) throw new Error('Invocation has already started');
    this.#started = true;
    const context = this.prepare();
    this.#context = context;
    try {
      writeRecord(() => this.register(context));
    } catch (error) {
      context.fail(error);
      throw error;
    }

    let output: O;
    try {
      output = await cycle(context, this.work, this.signal, (process) => writeRecord(() => this.recorder?.process(context, process)));
    } catch (error) {
      context.fail(error);
      try {
        writeRecord(() => this.recorder?.finish(context));
      } catch (registrationError) {
        throw new AggregateError([error, registrationError], 'Work failed and failure registration also failed', { cause: error });
      }
      throw error;
    }
    // Registration failure after success must not fail or repeat the completed work.
    context.complete(output);
    writeRecord(() => this.recorder?.finish(context));
    return output;
  }
}
