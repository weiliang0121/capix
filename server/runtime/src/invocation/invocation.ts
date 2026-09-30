import { InvocationChildren, type ParentInvocation } from './children.js';
import type { InvocationRelation, InvocationRelationOptions } from './relation.js';
import type { InvocationChangeEmitter } from './changes.js';
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
  parent?: { invocation: ParentInvocation } & InvocationRelationOptions;
  work: InvocationWork<C, I, O>;
  signal: AbortSignal;
  recording?: InvocationRecording<C>;
  started?: InvocationStarted<I, O, C>;
  validate?: () => void;
  changes?: InvocationChangeEmitter;
}

/** A single-use structured call. Context, progress and records belong to this invocation, not the behavior instance. */
export class Invocation<I = unknown, O = unknown, C extends InvocationContext<I, O> = InvocationContext<I, O>> {
  #started = false;
  #sequence = 0;
  #record?: CallRecord;
  readonly children: InvocationChildren;
  readonly #parentRelation?: InvocationRelation;

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

  constructor(private readonly options: InvocationOptions<I, O, C>) {
    this.children = new InvocationChildren(options.context);
    this.#parentRelation = options.parent?.invocation.children.attach(this, options.parent);
  }

  get context(): C {
    return this.options.context;
  }

  async run(): Promise<O> {
    if (this.#started) throw new Error('Invocation has already started');
    this.#started = true;
    try {
      const output = await this.execute();
      this.#parentRelation?.returnedWith({ status: 'succeeded', output });
      return output;
    } catch (error) {
      this.#parentRelation?.returnedWith({ status: 'failed', error });
      throw error;
    }
  }

  private async execute(): Promise<O> {
    const context = this.context;
    context.requireRunning();
    try {
      this.options.validate?.();
      this.options.started?.(context, this);
      this.options.changes?.publish({ kind: 'started' });
      writeRecord(() => {
        this.options.recording?.begin(context, (record) => this.bind(record));
        if (this.options.recording) this.requireRecord();
      });
    } catch (error) {
      context.fail(error);
      try {
        this.options.changes?.publish({ kind: 'finished', status: 'failed' });
      } catch (captureError) {
        throw new AggregateError([error, captureError], 'Call setup and its failure capture both failed', { cause: error });
      }
      throw error;
    }

    let output: O;
    try {
      output = await cycle(this, this.options.work, {
        signal: this.options.signal,
        onProcess: (process) => {
          const sequence = this.nextSequence();
          this.options.changes?.publish({ kind: 'process', processSequence: sequence, round: context.progress.round, stage: process.stage, action: process.type });
          writeRecord(() => this.options.recording?.process(context, this.requireRecord(), process, sequence));
        },
      });
    } catch (error) {
      context.fail(error);
      try {
        this.options.changes?.publish({ kind: 'finished', status: 'failed' });
        writeRecord(() => this.options.recording?.finish(context, this.requireRecord()));
      } catch (registrationError) {
        throw new AggregateError([error, registrationError], 'Work failed and failure registration also failed', { cause: error });
      }
      throw error;
    }
    // Registration failure after success must not fail or repeat the completed work.
    context.complete(output);
    this.options.changes?.publish({ kind: 'finished', status: 'succeeded' });
    writeRecord(() => this.options.recording?.finish(context, this.requireRecord()));
    return output;
  }
}
