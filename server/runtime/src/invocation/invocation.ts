import { InvocationCheckpoint } from '../checkpoint/invocation.js';
import type { CheckpointInstallation, CheckpointRestoration, CheckpointWriter } from '../checkpoint/contract.js';
import type { CheckpointBinding } from '../checkpoint/work.js';
import type { InvocationTarget } from './relation.js';
import type { InvocationOutputWriter, InvocationOutputReceiver } from '../output/contract.js';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from '../runtime/clock.js';
import { DeclaredException } from '../exception/contract.js';
import { InvocationStopped } from './stop.js';
import { isInvocationCancelled, requireNotCancelled } from './cancellation.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import { invocationContextView, type ContextFactsOf } from '../context/view.js';
import { invocationView, childInvocationView, type InvocationView, type ChildInvocationView } from './view.js';
import { InvocationChildren, type ParentInvocation } from './children.js';
import type { InvocationRelation, InvocationRelationOptions } from './relation.js';
import type { InvocationChangeEmitter } from './changes.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationObservation } from '../observation/invocation.js';
import type { InvocationChange, InvocationFact, InvocationIdentity, InvocationDescription, InvocationRelationIdentity, InvocationRelationChange, ExecutionEntryChange } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import { invocationChange, invocationProgress } from './facts.js';
import { InvocationCycle } from './cycle.js';
import { connectInvocationWork, type InvocationWork } from './work.js';
import { ProgressChannel, type ProgressReceiver } from '../progress/channel.js';
import type { InvocationProgress } from './progress.js';

/** Synchronous setup after validation, before progress, observation and work. Throws stop the call unchanged. */
export type InvocationStarted<Input, Output, Context extends InvocationContext<Input, Output>> = (context: Context, invocation: Invocation<Input, Output, Context>) => void;

export interface InvocationOptions<Input, Output, Context extends InvocationContext<Input, Output>> {
  context: Context;
  checkpoints?: CheckpointInstallation;
  restore?: CheckpointRestoration;
  clock?: Clock;
  parent?: { invocation: ParentInvocation } & InvocationRelationOptions;
  work: InvocationWork<Input, Output, Context>;
  signal: AbortSignal;
  observation?: InvocationObservation;
  identity?: InvocationIdentity;
  description?: InvocationDescription;
  started?: InvocationStarted<Input, Output, Context>;
  /** Local receiver for this call and its descendants; independently isolated from ancestors. */
  progress?: ProgressReceiver<InvocationProgress>;
  output?: InvocationOutputReceiver<Output>;
  /** Side-effect-free guard, checked at setup and before each execute/receive phase. */
  validate?: () => void;
  changes?: InvocationChangeEmitter;
}

/** A single-use structured call owns its Context and progress. Optional observation consumes its typed facts without requiring a particular carrier. */
export class Invocation<Input = unknown, Output = unknown, Context extends InvocationContext<Input, Output> = InvocationContext<Input, Output>> {
  readonly hasProgress: boolean;
  readonly #checkpoint?: InvocationCheckpoint<Input, Output, Context>;
  #started = false;
  readonly #cycle: InvocationCycle<Input, Output>;
  #sequence = 0;
  #eventSequence = 0;
  #resourceSequence = 0;
  readonly #clock: Clock;
  readonly #progress?: ProgressChannel<InvocationProgress>;
  readonly #identity: InvocationIdentity;
  #fault?: InvocationFailure;
  #classified?: InvocationFailure;
  #failure?: InvocationFailure;
  readonly children: InvocationChildren;
  readonly origin: Readonly<{ contextId: string }>;
  readonly view: InvocationView<Input, Output, ContextFactsOf<Context>>;
  readonly callView: ChildInvocationView<Input, Output, ContextFactsOf<Context>>;
  readonly #parentRelation?: InvocationRelation;

  constructor(private readonly options: InvocationOptions<Input, Output, Context>) {
    this.#clock = options.clock ?? new Clock();
    this.#progress = options.progress ? new ProgressChannel(options.progress) : undefined;
    this.hasProgress = !this.recovering && (!!this.#progress || !!options.parent?.invocation.hasProgress);
    this.#identity = Object.freeze(options.identity ? { ...options.identity } : { contextId: options.context.id, level: ('level' in options.context ? options.context.level : 'attempt') as InvocationIdentity['level'], ...(options.parent ? { parentContextId: options.parent.invocation.context.id } : {}) });
    this.children = new InvocationChildren(
      options.context,
      (failure) => {
        if (failure.kind === 'error' && !this.#fault) this.#fault = failure;
      },
      () => this.requireActive(),
      (relation, change) => this.publishRelation(relation, change),
    );
    this.origin = Object.freeze({ contextId: options.context.id });
    const context = invocationContextView(options.context);
    const invocation = this;
    const source = {
      origin: this.origin,
      get sequence() {
        return invocation.sequence;
      },
      get failure() {
        return invocation.failure;
      },
      children: this.children.view,
    };
    this.view = invocationView(source, context);
    this.callView = childInvocationView(source, context, () => this.run());
    if (options.restore && !options.checkpoints) throw new Error('Checkpoint persistence is missing');
    this.#cycle = new InvocationCycle(
      options.context,
      connectInvocationWork(options.work, options.context, this),
      {
        active: () => this.requireActive(),
        healthy: () => this.requireHealthy(),
        reject: (error) => this.reject(error),
        classify: (error, phase, forceError) => this.classify(error, phase, forceError),
      },
      {
        signal: options.signal,
        validate: options.validate,
        output: options.output,
        process: (process) => this.publish({ kind: 'process', process, processSequence: this.nextSequence(), round: options.context.progress.round }),
      },
    );
    this.#checkpoint = options.checkpoints ? new InvocationCheckpoint(this, options.checkpoints, options.work.checkpoint, options.signal, options.restore) : undefined;
    this.#parentRelation = options.parent ? (options.restore ? options.parent.invocation.children.adopt(this) : options.parent.invocation.children.attach(this, options.parent)) : undefined;
  }

  get context(): Context {
    return this.options.context;
  }

  get identity(): InvocationIdentity {
    return this.#identity;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get failure(): InvocationFailure | undefined {
    return this.#failure;
  }

  get outputWriter(): InvocationOutputWriter<unknown> {
    return this.#cycle.outputWriter;
  }

  get checkpointBinding(): CheckpointBinding | undefined {
    return this.options.work.checkpoint;
  }

  get checkpointWriter(): CheckpointWriter | undefined {
    return this.#checkpoint?.writer();
  }

  get restoring(): boolean {
    return !!this.options.restore;
  }

  get recovering(): boolean {
    return this.restoring || !!this.options.parent?.invocation.recovering;
  }

  get maxRounds(): number {
    return this.options.work.maxRounds;
  }

  get observation(): InvocationObservation | undefined {
    return this.recovering ? this.#checkpoint?.observation : this.options.observation;
  }

  async run(): Promise<Output> {
    if (this.#started) {
      const error = new Error('Invocation has already started');
      this.options.parent?.invocation.children.reject(error);
      throw error;
    }
    this.#started = true;
    try {
      this.#checkpoint?.begin();
      const output = await this.runWork();
      this.#checkpoint?.finish({ status: 'succeeded', output });
      this.#parentRelation?.returnedWith({ status: 'succeeded', output });
      return output;
    } catch (error) {
      return this.failDelivery(error);
    } finally {
      this.#checkpoint?.release();
    }
  }

  private async runWork(): Promise<Output> {
    const context = this.context;
    context.requireRunning();
    let output: Output;
    try {
      this.startWork();
      output = await this.#cycle.run(this.restoring ? () => this.#checkpoint!.resume() : undefined);
    } catch (error) {
      return this.failWork(error);
    }
    // Terminal observation may fail delivery, but never changes the committed work outcome.
    context.complete(output);
    this.#cycle.completeOutput(output);
    this.publish({ kind: 'finished', state: context.state });
    return output;
  }

  private startWork(): void {
    const context = this.context;
    this.options.parent?.invocation.children.requireHealthy();
    this.options.validate?.();
    this.options.started?.(context, this);
    if (!this.restoring) this.publish({ kind: 'started', input: context.input });
    if ('resources' in context) (context.resources as { start(): void }).start();
  }

  private failWork(error: unknown): never {
    const context = this.context;
    const failure = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, context.progress.round ? context.progress.phase : 'setup', true);
    const delivered = error instanceof AggregateError ? error : failure.error;
    this.#cycle.discardOutput('failed');
    context.fail(delivered, Object.freeze({ ...failure, error: delivered, ...(error instanceof AggregateError ? { kind: 'error' as const } : {}) }));
    try {
      this.publish({ kind: 'finished', state: context.state });
    } catch (observed) {
      throw new AggregateError([delivered, observed], 'Call failure and its observation both failed', { cause: delivered });
    }
    throw delivered;
  }

  private failDelivery(error: unknown): never {
    const classified = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, this.context.status === 'succeeded' ? 'observation' : this.context.progress.phase, true);
    let delivered = error instanceof AggregateError ? error : classified.error;
    try {
      this.#checkpoint?.finish({ status: isInvocationCancelled(delivered, this.options.signal) ? 'cancelled' : 'failed' });
    } catch (checkpointError) {
      delivered = new AggregateError([delivered, checkpointError], 'Invocation failure and terminal checkpoint save failed', { cause: delivered });
    }
    this.#failure = Object.freeze({ ...classified, ...(delivered instanceof AggregateError ? { kind: 'error' as const } : {}), error: delivered });
    if (this.context.status === 'running') this.context.fail(delivered, this.#failure);
    this.#parentRelation?.returnedWith({ status: 'failed', error: delivered, failure: this.#failure });
    throw delivered;
  }

  requireHealthy(): void {
    if (this.#fault) throw this.#fault.error;
  }

  /** Work access stops cooperatively; completion and reporting do not use this guard. */
  requireActive(): void {
    this.requireHealthy();
    this.context.requireRunning();
    requireNotCancelled(this.options.signal);
  }

  /** Internal endpoint boundary. Once an error occurs, work cannot turn it into success. */
  reject(error: unknown, allowException = false): void {
    this.classify(error, this.context.progress.phase, !allowException);
  }

  classify(error: unknown, phase: InvocationPhase, forceError = false): InvocationFailure {
    if (this.#fault) {
      // A structural report can add a second cause; retain it without allowing
      // caught business code to replace an already-owned failure.
      if (error instanceof AggregateError && (error.errors.includes(this.#fault.error) || error.cause === this.#fault.error)) this.#fault = Object.freeze({ ...this.#fault, error });
      return this.#fault;
    }
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

  restoreChild(binding: CheckpointBinding, contextId: string, create: () => InvocationTarget): InvocationTarget {
    try {
      this.requireActive();
      if (!this.#checkpoint) throw new Error('Child continuation requires a restored parent');
      return this.#checkpoint.restoreChild(binding, contextId, create);
    } catch (error) {
      this.#checkpoint?.reportFailure('restore', error, contextId);
      this.reject(error);
      throw error;
    }
  }

  nextResourceSequence(): number {
    return ++this.#resourceSequence;
  }

  private nextSequence(): number {
    return ++this.#sequence;
  }

  /** Internal parent-owned entry outlet, omitted from the business invocation view. */
  publishEntry(change: ExecutionEntryChange): void {
    this.publish({ kind: 'entry', ...change });
  }

  /** Internal forwarding preserves producer identity and sequence; absent from business views. */
  publishProgress(fact: InvocationProgress): void {
    if (this.recovering) return;
    this.#progress?.publish(fact);
    this.options.parent?.invocation.publishProgress?.(fact);
  }

  private publishRelation(relation: InvocationRelationIdentity, change: InvocationRelationChange): unknown | undefined {
    try {
      this.publish({ kind: 'relation', relation, change });
      return undefined;
    } catch (error) {
      // A child's failure is already owned by the parent before returned is published.
      // Keep the additional observer failure here without changing the child's delivery.
      const failure = change.kind === 'returned' && change.result.status === 'failed' && this.#fault && this.#fault.error !== error ? new AggregateError([this.#fault.error, error], 'Child return and parent observation both failed', { cause: this.#fault.error }) : error;
      this.classify(failure, 'observation', true);
      return failure;
    }
  }

  private publish(change: InvocationChange): void {
    const identity = this.#identity;
    const fact: InvocationFact = Object.freeze({ ...change, identity, description: this.options.description, eventSequence: ++this.#eventSequence, occurredAt: this.#clock.now(), monotonicTime: this.#clock.tick() });
    // A passive consumer sees the established fact even if strict observation fails next.
    if (this.hasProgress) {
      const progress = invocationProgress(fact, this.options.signal);
      if (progress) this.publishProgress(progress);
    }
    const faults: unknown[] = [];
    try {
      const captured = invocationChange(fact);
      (this.recovering ? undefined : this.options.changes)?.publish(captured, { sequence: fact.eventSequence, occurredAt: fact.occurredAt });
    } catch (error) {
      faults.push(error);
    }
    const observed = this.observation?.publish(fact);
    if (!isUndefined(observed)) faults.push(observed);
    const error = combineFaults(faults);
    if (!isUndefined(error)) {
      this.classify(error, 'observation', true);
      throw error;
    }
  }
}
