import { DeclaredException } from '../exception/contract.js';
import { InvocationStopped } from './stop.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import { invocationScope, type InvocationFactsOf } from '../context/scope.js';
import type { InvocationView, ChildCall } from './view.js';
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
  /** Side-effect-free guard, checked at setup and before each execute/receive phase. */
  validate?: () => void;
  changes?: InvocationChangeEmitter;
}

/** A single-use structured call. Context, progress and records belong to this invocation, not the behavior instance. */
export class Invocation<I = unknown, O = unknown, C extends InvocationContext<I, O> = InvocationContext<I, O>> {
  #started = false;
  #sequence = 0;
  #record?: CallRecord;
  #fault?: InvocationFailure;
  #classified?: InvocationFailure;
  #failure?: InvocationFailure;

  get failure(): InvocationFailure | undefined {
    return this.#failure;
  }

  /** Internal endpoint boundary. Once an error occurs, work cannot turn it into success. */
  reject(error: unknown, allowException = false): void {
    this.classify(error, this.context.progress.phase, !allowException);
  }

  requireHealthy(): void {
    if (this.#fault) throw this.#fault.error;
  }

  classify(error: unknown, phase: InvocationPhase, forceError = false): InvocationFailure {
    if (this.#fault) return this.#fault;
    if (!forceError && this.#classified && this.#classified.error === error) return this.#classified;
    const declared = !forceError && error instanceof DeclaredException;
    const delivered = this.children.values().some((relation) => relation.returned?.status === 'failed' && relation.returned.error === error && relation.returned.failure?.kind === 'exception');
    const allowed = declared && (this.options.work.raises?.includes(error.contract) || delivered);
    const actual = forceError && error instanceof DeclaredException ? new InvocationStopped(phase === 'handling' ? 'EXCEPTION_HANDLER_FAILED' : 'INVOCATION_FAILED', '结构处理抛出的异常不能再次进入业务处理。', undefined, { cause: error }) : declared && !allowed ? new InvocationStopped('UNDECLARED_EXCEPTION', '工作产生了未声明的异常。', { contract: error.contract.name }, { cause: error }) : error;
    const failure: InvocationFailure = Object.freeze({ kind: allowed ? 'exception' : 'error', phase, contextId: this.context.id, ...(allowed ? { contract: error.contract.name } : {}), error: actual });
    this.#classified = failure;
    if (failure.kind === 'error') this.#fault = failure;
    return failure;
  }
  readonly children: InvocationChildren;
  readonly origin: Readonly<{ contextId: string }>;
  readonly view: InvocationView<I, O, InvocationFactsOf<C>>;
  readonly callView: ChildCall<I, O, InvocationFactsOf<C>>;
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
    this.children = new InvocationChildren(
      options.context,
      (failure) => {
        if (failure.kind === 'error' && !this.#fault) this.#fault = failure;
      },
      () => this.requireHealthy(),
    );
    this.origin = Object.freeze({ contextId: options.context.id });
    const context = invocationScope(options.context);
    const invocation = this;
    this.view = Object.freeze({
      context,
      origin: this.origin,
      get sequence() {
        return invocation.sequence;
      },
      get failure() {
        return invocation.failure;
      },
      children: this.children.view,
    });
    this.callView = Object.freeze({
      context,
      origin: this.origin,
      get sequence() {
        return invocation.sequence;
      },
      get failure() {
        return invocation.failure;
      },
      children: this.children.view,
      run: () => this.run(),
    });
    this.#parentRelation = options.parent?.invocation.children.attach(this, options.parent);
  }

  get context(): C {
    return this.options.context;
  }

  async run(): Promise<O> {
    if (this.#started) {
      const error = new Error('Invocation has already started');
      this.options.parent?.invocation.children.reject(error);
      throw error;
    }
    this.#started = true;
    try {
      const output = await this.execute();
      this.#parentRelation?.returnedWith({ status: 'succeeded', output });
      return output;
    } catch (error) {
      const classified = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, this.context.status === 'succeeded' ? 'observation' : this.context.progress.phase, true);
      const delivered = error instanceof AggregateError ? error : classified.error;
      this.#failure = Object.freeze({ ...classified, ...(error instanceof AggregateError ? { kind: 'error' as const } : {}), error: delivered });
      this.#parentRelation?.returnedWith({ status: 'failed', error: delivered, failure: this.#failure });
      throw delivered;
    }
  }

  private async execute(): Promise<O> {
    const context = this.context;
    context.requireRunning();
    try {
      this.options.parent?.invocation.children.requireHealthy();
      this.options.validate?.();
      this.options.started?.(context, this);
      this.options.changes?.publish({ kind: 'started' });
      writeRecord(() => {
        this.options.recording?.begin(context, (record) => this.bind(record));
        if (this.options.recording) this.requireRecord();
      });
    } catch (error) {
      const failure = this.classify(error, 'setup', true);
      context.fail(failure.error, failure);
      try {
        this.options.changes?.publish({ kind: 'finished', status: 'failed' });
      } catch (captureError) {
        throw new AggregateError([error, captureError], 'Call setup and its failure capture both failed', { cause: error });
      }
      throw error;
    }

    let output: O;
    try {
      if ('resources' in context) (context.resources as { start(): void }).start();
      output = await cycle(this, this.options.work, {
        signal: this.options.signal,
        validate: this.options.validate,
        onProcess: (process) => {
          const sequence = this.nextSequence();
          this.options.changes?.publish({ kind: 'process', processSequence: sequence, round: context.progress.round, stage: process.stage, action: process.type });
          writeRecord(() => this.options.recording?.process(context, this.requireRecord(), process, sequence));
        },
      });
    } catch (error) {
      const failure = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, context.progress.phase, true);
      context.fail(error, Object.freeze({ ...failure, error, ...(error instanceof AggregateError ? { kind: 'error' as const } : {}) }));
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
