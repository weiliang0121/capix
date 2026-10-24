import { InvocationCheckpoint } from '../checkpoint/invocation.js';
import type { CheckpointInstallation, CheckpointRestoration, CheckpointWriter } from '../checkpoint/contract.js';
import type { CheckpointBinding } from '../checkpoint/work.js';
import type { InvocationTarget } from './relation.js';
import type { InvocationOutputWriter, InvocationOutputReceiver } from '../output/contract.js';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from '../clock.js';
import { DeclaredException } from '../exception/contract.js';
import { isProtectedOperationFailure } from '../operation/failure.js';
import { InvocationStopped } from './stop.js';
import { isInvocationCancelled } from './cancellation.js';
import { InvocationControl } from './control.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import { containsFailure } from './failure.js';
import { invocationContextView, type ContextFactsOf } from '../context/view.js';
import { invocationView, childInvocationView, type InvocationView, type ChildInvocationView } from './view.js';
import { InvocationChildren, type ParentInvocation } from './children.js';
import type { InvocationRelation, InvocationRelationOptions } from './relation.js';
import type { InvocationChangeEmitter } from './changes.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationObservation } from '../observation/invocation.js';
import type { InvocationChange, InvocationFact, InvocationIdentity, InvocationDescription, InvocationRelationIdentity, InvocationRelationChange, BusinessEvent } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import { invocationChange, invocationProgress } from './facts.js';
import { InvocationCycle } from './cycle.js';
import { connectInvocationWork, type InvocationWork } from './work.js';
import { ProgressChannel, type ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from './progress.js';
import type { InvocationExceptionOrigin, InvocationPropagationScope } from './provenance.js';

/** Synchronous setup after validation, before progress, observation and work. Throws stop the call unchanged. */
export type InvocationStarted<Input, Output, Context extends InvocationContext<Input, Output>> = (context: Context, invocation: Invocation<Input, Output, Context>) => undefined;

export interface InvocationOptions<Input, Output, Context extends InvocationContext<Input, Output>> {
  context: Context;
  /** Fixed host binding scope, authenticated by construction; never exposed through business Work. */
  construction?: object;
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
  readonly #control: InvocationControl;
  readonly #cycle: InvocationCycle<Input, Output>;
  #sequence = 0;
  #eventSequence = 0;
  #resourceSequence = 0;
  #businessSequence = 0;
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
  #parentDeliveryScope?: InvocationPropagationScope;

  constructor(private readonly options: InvocationOptions<Input, Output, Context>) {
    this.#control = new InvocationControl(options.signal);
    this.#clock = options.clock ?? new Clock();
    this.#progress = options.progress ? new ProgressChannel(options.progress) : undefined;
    this.hasProgress = !this.recovering && (!!this.#progress || !!options.parent?.invocation.hasProgress);
    this.#identity = Object.freeze(options.identity ? { ...options.identity } : { contextId: options.context.id, kind: ('kind' in options.context ? options.context.kind : 'node') as InvocationIdentity['kind'], ...(options.parent ? { parentContextId: options.parent.invocation.context.id } : {}) });
    this.children = new InvocationChildren(
      options.context,
      (failure) => {
        if (failure.kind === 'error' && !this.#fault) this.#fault = failure;
      },
      () => this.requireActive(),
      (relation, change) => this.publishRelation(relation, change),
      (error, origin) => this.classify(error, this.context.progress.phase, false, origin),
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
        settleAcceptances: () => this.children.settleAcceptances(),
      },
      {
        signal: options.signal,
        validate: options.validate,
        output: options.output,
        process: (process, round = options.context.progress.round) => this.publish({ kind: 'process', process, processSequence: this.nextSequence(), round }),
      },
    );
    this.#checkpoint = options.checkpoints ? new InvocationCheckpoint(this, options.checkpoints, options.work.checkpoint, options.signal, options.restore) : undefined;
    this.#parentRelation = options.parent ? (options.restore ? options.parent.invocation.children.adopt(this) : options.parent.invocation.children.attach(this, options.parent)) : undefined;
  }

  get context(): Context {
    return this.options.context;
  }

  get construction(): object | undefined {
    return this.options.construction;
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

  get exceptionOrigin(): InvocationExceptionOrigin | undefined {
    return this.#cycle.exceptionFailure?.origin;
  }

  get outputWriter(): InvocationOutputWriter<unknown> {
    return this.#cycle.outputWriter;
  }

  /** A restored execute body may end before its active receptions have drained. */
  sealOutput(): void {
    this.#cycle.sealOutput();
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

  run(): Promise<Output> {
    try {
      this.#control.start();
      this.#parentDeliveryScope = this.options.parent?.invocation.children.captureDelivery();
      return this.options.parent ? this.options.parent.invocation.children.run(this, () => this.deliver()) : this.deliver();
    } catch (error) {
      this.options.parent?.invocation.children.reject(error);
      return Promise.reject(error);
    }
  }

  private async deliver(): Promise<Output> {
    try {
      this.#checkpoint?.begin();
      const output = await this.runWork();
      this.#checkpoint?.finish({ status: 'succeeded', output });
      this.#parentRelation?.returnedWith({ status: 'succeeded', output });
      return output;
    } catch (error) {
      return this.failDelivery(error);
    } finally {
      this.#control.close();
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
      this.#control.close();
      await this.children.settle();
      return this.failWork(error);
    }
    this.#control.close();
    await this.children.settle();
    // A child's already-owned fault remains authoritative even if its caller did not await it.
    try {
      this.requireHealthy();
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
    const registered: unknown = this.options.started?.(context, this);
    if (registered !== undefined) {
      // Reject async setup without letting a late rejection escape the failed call.
      void Promise.resolve(registered).catch(() => undefined);
      throw new TypeError('Invocation started callbacks must return undefined synchronously');
    }
    if (!this.restoring) this.publish({ kind: 'started', input: context.input });
    if ('resources' in context) (context.resources as { start(phase: string): void }).start(this.options.restore ? `checkpoint:${this.options.restore.head.image.point}` : 'run');
  }

  private failWork(error: unknown): never {
    const context = this.context;
    // A handler may inspect or reject repair children before declining its original
    // exception. That handled failure remains authoritative; a later diagnostic
    // classification does not replace it, while structural faults remain sticky.
    const handled = this.#cycle.exceptionFailure;
    const exit = this.#cycle.exitFailure;
    const failure = this.#fault ?? (handled && handled.error === error ? handled : exit && exit.error === error ? exit : this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, context.progress.round ? context.progress.phase : 'setup', true));
    this.#classified = failure;
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
    let receptionAllowed = classified.receptionAllowed === true && !isProtectedOperationFailure(delivered);
    try {
      this.#checkpoint?.finish({ status: isInvocationCancelled(delivered, this.options.signal) ? 'cancelled' : 'failed' });
    } catch (checkpointError) {
      delivered = new AggregateError([delivered, checkpointError], 'Invocation failure and terminal checkpoint save failed', { cause: delivered });
      receptionAllowed = false;
    }
    this.#failure = Object.freeze({ ...classified, ...(delivered instanceof AggregateError ? { kind: 'error' as const } : {}), error: delivered, receptionAllowed });
    if (this.context.status === 'running') this.context.fail(delivered, this.#failure);
    this.#parentRelation?.returnedWith({ status: 'failed', error: delivered, failure: this.#failure });
    throw this.#parentRelation && this.#parentDeliveryScope ? this.options.parent!.invocation.children.deliverReturn(this.#parentRelation, delivered, this.#failure, this.#parentDeliveryScope) : delivered;
  }

  requireHealthy(): void {
    if (this.#fault) throw this.#fault.error;
  }

  /** Work access stops cooperatively; completion and reporting do not use this guard. */
  requireActive(): void {
    this.requireHealthy();
    this.context.requireRunning();
    this.#control.requireActive();
  }

  /** Internal endpoint boundary. Once an error occurs, work cannot turn it into success. */
  reject(error: unknown, allowException = false): void {
    this.classify(error, this.context.progress.phase, !allowException);
  }

  classify(error: unknown, phase: InvocationPhase, forceError = false, origin?: InvocationExceptionOrigin): InvocationFailure {
    if (this.#fault) {
      if (['observation', 'control', 'setup'].includes(phase) || isProtectedOperationFailure(error)) this.#fault = Object.freeze({ ...this.#fault, receptionAllowed: false });
      // A structural report can add a second cause; retain it without allowing
      // caught business code to replace an already-owned failure.
      if (error instanceof AggregateError && containsFailure(error, this.#fault.error)) this.#fault = Object.freeze({ ...this.#fault, error });
      return this.#fault;
    }
    let propagation;
    try {
      propagation = this.children.resolveDelivery(error);
    } catch (invalid) {
      error = invalid;
      forceError = true;
    }
    const exception = propagation?.exception ?? error;
    const declared = !forceError && exception instanceof DeclaredException;
    const allowed = declared && (!!propagation || this.options.work.raises?.includes(exception.contract));
    const actual = forceError && exception instanceof DeclaredException ? new InvocationStopped(phase === 'handling' ? 'EXCEPTION_HANDLER_FAILED' : 'INVOCATION_FAILED', '结构处理抛出的异常不能再次进入业务处理。', undefined, { cause: exception }) : declared && !allowed ? new InvocationStopped('UNDECLARED_EXCEPTION', '工作产生了未声明的异常。', { contract: exception.contract.name }, { cause: exception }) : exception;
    const source = propagation?.origin ?? origin ?? Object.freeze({ kind: 'self' as const, phase: phase === 'receive' ? ('accept' as const) : ('execute' as const) });
    const failure: InvocationFailure = Object.freeze({ kind: allowed ? 'exception' : 'error', phase, contextId: this.context.id, ...(allowed ? { contract: exception.contract.name, origin: source } : {}), error: actual, receptionAllowed: !forceError && !isProtectedOperationFailure(actual) });
    this.#classified = failure;
    if (failure.kind === 'error') this.#fault = failure;
    return failure;
  }

  restoreChild(position: number, contextId: string, create: () => InvocationTarget): InvocationTarget {
    try {
      this.requireActive();
      if (!this.#checkpoint) throw new Error('Child continuation requires a restored parent');
      return this.#checkpoint.restoreChild(position, contextId, create);
    } catch (error) {
      this.#checkpoint?.reportFailure('restore', error, contextId);
      this.reject(error);
      throw error;
    }
  }

  nextResourceSequence(): number {
    return ++this.#resourceSequence;
  }

  observeBusiness(event: BusinessEvent): void {
    this.requireActive();
    if (!event || typeof event.event !== 'string' || !event.event.trim()) throw new TypeError('Business observation needs an event name');
    const fact = Object.freeze({ identity: this.identity, sequence: ++this.#businessSequence, occurredAt: this.#clock.now(), event: Object.freeze({ ...event }) });
    const failure = this.observation?.business.publish(fact);
    if (failure !== undefined) {
      this.classify(failure, 'observation', true);
      throw failure;
    }
  }

  private nextSequence(): number {
    return ++this.#sequence;
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
