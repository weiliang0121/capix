import type { CallRecord } from '../records/invocation/record.js';
import type { ChangeSource } from '../records/source.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationRecording } from './recording.js';
import { writeRecord } from '../records/error.js';
import { cycle, type InvocationWork } from './cycle.js';

/** Synchronous setup after validation, before record registration and work. Throws stop the call unchanged. */
export type InvocationStarted<I, O, C extends InvocationContext<I, O>> = (context: C, invocation: Invocation<I, O, C>) => void;

export interface InvocationOptions<I, O, C extends InvocationContext<I, O>> {
  context: C;
  work: InvocationWork<C, I, O>;
  signal: AbortSignal;
  recording?: InvocationRecording<C>;
  started?: InvocationStarted<I, O, C>;
  validate?: () => void;
}

/** A single-use structured call. Context, progress and records belong to this invocation, not the behavior instance. */
export class Invocation<I = unknown, O = unknown, C extends InvocationContext<I, O> = InvocationContext<I, O>> {
  #started = false;
  #sequence = 0;
  #record?: CallRecord;

  get record(): CallRecord | undefined {
    return this.#record;
  }

  get source(): ChangeSource | undefined {
    if (!this.options.recording) return undefined;
    return this.options.recording.source(this.requireRecord());
  }

  private bind(record: CallRecord): void {
    if (this.#record) throw new Error('Invocation record is already bound');
    if (record.contextId !== this.context.id) throw new Error('Invocation record belongs to another Context');
    this.#record = record;
  }

  private requireRecord(): CallRecord {
    if (!this.#record) throw new Error('Invocation record is not bound');
    return this.#record;
  }

  get sequence(): number {
    return this.#sequence;
  }

  private nextSequence(): number {
    return ++this.#sequence;
  }

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
      this.options.started?.(context, this);
      writeRecord(() => {
        this.options.recording?.begin(context, (record) => this.bind(record));
        if (this.options.recording) this.requireRecord();
      });
    } catch (error) {
      context.fail(error);
      throw error;
    }

    let output: O;
    try {
      output = await cycle(
        context,
        this.options.work,
        this.options.signal,
        (process) => {
          const sequence = this.nextSequence();
          writeRecord(() => this.options.recording?.process(context, this.requireRecord(), process, sequence));
        },
        this,
      );
    } catch (error) {
      context.fail(error);
      try {
        writeRecord(() => this.options.recording?.finish(context, this.requireRecord()));
      } catch (registrationError) {
        throw new AggregateError([error, registrationError], 'Work failed and failure registration also failed', { cause: error });
      }
      throw error;
    }
    // Registration failure after success must not fail or repeat the completed work.
    context.complete(output);
    writeRecord(() => this.options.recording?.finish(context, this.requireRecord()));
    return output;
  }
}
