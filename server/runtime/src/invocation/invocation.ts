import { InvocationCheckpoint } from '../checkpoint/invocation.js';
import type { CheckpointInstallation, CheckpointRestoration, CheckpointWriter } from '../checkpoint/contract.js';
import type { CheckpointBinding } from '../checkpoint/work.js';
import { cloneCheckpointHead } from '../checkpoint/value.js';
import { checkpointTarget } from '../checkpoint/target.js';
import type { InvocationTarget } from './relation.js';
import { isEqual } from 'es-toolkit';
import { InvocationOutputSection } from '../output/section.js';
import type { InvocationOutputWriter, InvocationOutputReceiver, InvocationOutputEvent } from '../output/contract.js';
import { isUndefined } from 'es-toolkit/predicate';
import { RuntimeErrorHelper } from '../errors/helper.js';
import { Clock } from '../runtime/clock.js';
import { DeclaredException } from '../exception/contract.js';
import { InvocationStopped } from './stop.js';
import { isInvocationCancelled, requireNotCancelled } from './cancellation.js';
import type { InvocationFailure, InvocationPhase } from './failure.js';
import { invocationContextView, type ContextFactsOf } from '../context/view.js';
import type { InvocationView, ChildInvocationView } from './view.js';
import { InvocationChildren, type ParentInvocation } from './children.js';
import type { InvocationRelation, InvocationRelationOptions } from './relation.js';
import type { InvocationChangeEmitter } from './changes.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationObservation } from '../observation/invocation.js';
import type { InvocationChange, InvocationFact, InvocationIdentity, InvocationDescription, InvocationRelationIdentity, InvocationRelationChange, ExecutionEntryChange } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import { failureFact } from './failure.js';
import { cycle, type InvocationWork } from './cycle.js';
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
  readonly #resumed = new Map<string, InvocationTarget>();
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
  get identity(): InvocationIdentity {
    return this.#identity;
  }
  get maxRounds(): number {
    return this.options.work.maxRounds;
  }
  resumeWork(): Promise<Output> {
    if (!this.#checkpoint) throw new Error('Checkpoint capability is missing');
    return this.#checkpoint.resume();
  }
  restoreChild(binding: CheckpointBinding, contextId: string, create: () => InvocationTarget): InvocationTarget {
    try {
      this.requireActive();
      if (!this.#checkpoint || !this.restoring) throw new Error('Child continuation requires a restored parent');
      const saved = this.children.saved(contextId);
      const resumed = this.#resumed.get(contextId);
      const contract = saved?.contract ?? resumed?.checkpointBinding;
      if (!contract || contract.key !== binding.key || contract.version !== binding.version) throw new Error('Child continuation contract or ownership mismatch');
      if (resumed) return resumed;
      if (!saved) throw new Error('Child continuation basis is unavailable');
      if (saved.state.kind === 'failed') throw new Error('Historical failed child cannot be resumed');
      let child = saved;
      if (saved.state.kind === 'waiting') {
        const value = this.#checkpoint.store.read(contextId);
        if (!value) throw new Error('Waiting child has no durable continuation; execution is unknown');
        const head = cloneCheckpointHead(value);
        if (!isEqual(head.image.frame.owner, saved.identity) || !isEqual(head.image.frame.input, saved.input) || !isEqual(head.image.contract, saved.contract)) throw new Error('Child checkpoint differs from parent-owned identity');
        if (!head.delivery) {
          const target = create();
          if (target.context.id !== contextId || this.children.get(target).round !== saved.round) throw new Error('Child continuation did not adopt the saved relationship');
          this.#resumed.set(contextId, target);
          this.#checkpoint.childRestored(saved, 'continuation');
          return target;
        }
        if (head.delivery.status !== 'succeeded') throw new Error('Failed or cancelled child cannot be resumed');
        child = { ...saved, state: { kind: 'returned', output: head.delivery.output, progress: head.delivery.progress, reception: { kind: 'pending' } } };
      }
      const target = checkpointTarget(child, binding, this.options.signal);
      this.children.replaceSaved(child, target);
      this.#resumed.set(contextId, target);
      this.#checkpoint.childRestored(child, 'delivery');
      return target;
    } catch (error) {
      this.#checkpoint?.reportFailure('restore', error, contextId);
      this.reject(error);
      throw error;
    }
  }
  #started = false;
  #outputSection?: InvocationOutputSection<Output>;
  readonly #outputDelivery?: ProgressChannel<InvocationOutputEvent<Output>>;
  #sequence = 0;
  #eventSequence = 0;
  #resourceSequence = 0;
  readonly #clock: Clock;
  readonly #progress?: ProgressChannel<InvocationProgress>;
  readonly #identity: InvocationIdentity;
  #fault?: InvocationFailure;
  #classified?: InvocationFailure;
  #failure?: InvocationFailure;

  get outputWriter(): InvocationOutputWriter<unknown> {
    if (!this.#outputSection) throw new Error('Invocation has no executing output segment');
    return this.#outputSection.writer;
  }

  openOutput(): void {
    this.#outputSection = new InvocationOutputSection(this.context.id, this.context.progress.round, this.options.work.output, { active: () => this.requireActive(), reject: (error) => this.reject(error) }, this.#outputDelivery);
    this.#outputSection.start();
  }

  sealOutput(): void {
    this.#outputSection?.seal();
  }
  discardOutput(reason: 'exception' | 'continue' | 'failed'): void {
    this.#outputSection?.discard(reason);
  }
  validateOutput(value: Output): Output {
    // Acceptance may already have committed a result when it requests cancellation.
    // Only a new cancellation during declaration validation interrupts this boundary.
    const cancelledBeforeValidation = this.options.signal.aborted;
    const output = this.#outputSection ? this.#outputSection.validateResult(value) : value;
    this.requireHealthy();
    if (!cancelledBeforeValidation) requireNotCancelled(this.options.signal);
    return output;
  }

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

  /** Work access stops cooperatively; completion and reporting do not use this guard. */
  requireActive(): void {
    this.requireHealthy();
    this.context.requireRunning();
    requireNotCancelled(this.options.signal);
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
  readonly children: InvocationChildren;
  readonly origin: Readonly<{ contextId: string }>;
  readonly view: InvocationView<Input, Output, ContextFactsOf<Context>>;
  readonly callView: ChildInvocationView<Input, Output, ContextFactsOf<Context>>;
  readonly #parentRelation?: InvocationRelation;

  get observation(): InvocationObservation | undefined {
    return this.recovering ? this.#checkpoint?.observation : this.options.observation;
  }

  nextResourceSequence(): number {
    return ++this.#resourceSequence;
  }

  get sequence(): number {
    return this.#sequence;
  }

  private nextSequence(): number {
    return ++this.#sequence;
  }

  constructor(private readonly options: InvocationOptions<Input, Output, Context>) {
    this.#clock = options.clock ?? new Clock();
    this.#outputDelivery = options.output ? new ProgressChannel(options.output) : undefined;
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
      options.signal,
    );
    this.origin = Object.freeze({ contextId: options.context.id });
    const context = invocationContextView(options.context);
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
    if (options.restore && !options.checkpoints) throw new Error('Checkpoint persistence is missing');
    this.#checkpoint = options.checkpoints ? new InvocationCheckpoint(this, options.checkpoints, options.work.checkpoint, options.restore) : undefined;
    this.#parentRelation = options.parent ? (options.restore ? options.parent.invocation.children.adopt(this) : options.parent.invocation.children.attach(this, options.parent)) : undefined;
  }

  get context(): Context {
    return this.options.context;
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
      const output = await this.execute();
      this.#checkpoint?.finish({ status: 'succeeded', output });
      this.#parentRelation?.returnedWith({ status: 'succeeded', output });
      return output;
    } catch (error) {
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
    } finally {
      this.#checkpoint?.release();
    }
  }

  /** Internal parent-owned entry outlet, omitted from the business invocation view. */
  publishEntry(change: ExecutionEntryChange): void {
    this.publish({ kind: 'entry', ...change });
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

  /** Internal forwarding preserves producer identity and sequence; absent from business views. */
  publishProgress(fact: InvocationProgress): void {
    if (this.recovering) return;
    this.#progress?.publish(fact);
    this.options.parent?.invocation.publishProgress?.(fact);
  }

  private progress(fact: InvocationFact): void {
    if (!this.hasProgress || fact.kind === 'entry') return;
    const description: { name?: string; label?: string } = {};
    // Descriptions are optional metadata. Accessors and proxies must not run work
    // or introduce a new failure through the passive outlet.
    try {
      if (fact.description) {
        for (const key of ['name', 'label'] as const) {
          const property = Object.getOwnPropertyDescriptor(fact.description, key);
          if (property && 'value' in property && typeof property.value === 'string') description[key] = property.value;
        }
      }
    } catch {
      // A hostile description cannot prevent publication of the underlying fact.
    }
    const identity = Object.freeze({ contextId: fact.identity.contextId, level: fact.identity.level, ...(fact.identity.parentContextId ? { parentContextId: fact.identity.parentContextId } : {}) });
    const base = { identity, eventSequence: fact.eventSequence, occurredAt: fact.occurredAt, ...(Object.keys(description).length ? { description: Object.freeze(description) } : {}) };
    if (fact.kind === 'started') this.publishProgress(Object.freeze({ ...base, kind: 'started' }));
    else if (fact.kind === 'process') this.publishProgress(Object.freeze({ ...base, kind: 'process', processSequence: fact.processSequence, round: fact.round, stage: fact.process.stage, action: fact.process.type }));
    else if (fact.kind === 'relation') {
      const relation = Object.freeze({ parentContextId: fact.relation.parentContextId, childContextId: fact.relation.childContextId, parentRound: fact.relation.parentRound, ...(fact.relation.key ? { key: fact.relation.key } : {}) });
      if (fact.change.kind === 'returned') {
        const result = fact.change.result;
        const status = result.status === 'succeeded' ? 'succeeded' : isInvocationCancelled(result.error, this.options.signal) ? 'cancelled' : 'failed';
        this.publishProgress(Object.freeze({ ...base, kind: 'relation', relation, phase: 'returned', status }));
      } else this.publishProgress(Object.freeze({ ...base, kind: 'relation', relation, phase: fact.change.kind }));
    } else {
      const state = fact.state;
      const status = state.status === 'succeeded' ? 'succeeded' : state.status === 'failed' && isInvocationCancelled(state.error, this.options.signal) ? 'cancelled' : 'failed';
      this.publishProgress(Object.freeze({ ...base, kind: 'finished', status }));
    }
  }

  private publish(change: InvocationChange): void {
    const identity = this.#identity;
    const fact: InvocationFact = Object.freeze({ ...change, identity, description: this.options.description, eventSequence: ++this.#eventSequence, occurredAt: this.#clock.now(), monotonicTime: this.#clock.tick() });
    // A passive consumer sees the established fact even if strict observation fails next.
    this.progress(fact);
    const faults: unknown[] = [];
    try {
      let captured;
      if (fact.kind === 'process') captured = { kind: 'process' as const, processSequence: fact.processSequence, round: fact.round, stage: fact.process.stage, action: fact.process.type };
      else if (fact.kind === 'entry') captured = { kind: 'entry' as const, target: fact.target, instanceId: fact.instanceId, ...(fact.key ? { key: fact.key } : {}), stage: fact.stage, status: fact.status, ...(fact.status === 'failed' ? { error: RuntimeErrorHelper.format(fact.error) } : {}) };
      else if (fact.kind === 'relation') captured = { kind: 'relation' as const, identity: fact.relation, phase: fact.change.kind, ...(fact.change.kind === 'returned' ? { status: fact.change.result.status, ...(fact.change.result.status === 'failed' && fact.change.result.failure ? { failure: failureFact(fact.change.result.failure) } : {}) } : {}) };
      else if (fact.kind === 'finished') captured = { kind: 'finished' as const, status: fact.state.status === 'succeeded' ? ('succeeded' as const) : ('failed' as const) };
      else captured = { kind: 'started' as const };
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

  private async execute(): Promise<Output> {
    const context = this.context;
    context.requireRunning();
    let output: Output;
    try {
      this.options.parent?.invocation.children.requireHealthy();
      this.options.validate?.();
      this.options.started?.(context, this);
      if (!this.restoring) this.publish({ kind: 'started', input: context.input });
      if ('resources' in context) (context.resources as { start(): void }).start();
      output = await cycle(this, this.options.work, {
        signal: this.options.signal,
        validate: this.options.validate,
        onProcess: (process) => this.publish({ kind: 'process', process, processSequence: this.nextSequence(), round: context.progress.round }),
      });
    } catch (error) {
      const failure = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, context.progress.round ? context.progress.phase : 'setup', true);
      const delivered = error instanceof AggregateError ? error : failure.error;
      this.#outputSection?.discard('failed');
      context.fail(delivered, Object.freeze({ ...failure, error: delivered, ...(error instanceof AggregateError ? { kind: 'error' as const } : {}) }));
      try {
        this.publish({ kind: 'finished', state: context.state });
      } catch (observed) {
        throw new AggregateError([delivered, observed], 'Call failure and its observation both failed', { cause: delivered });
      }
      throw delivered;
    }
    // Terminal observation may fail delivery, but never changes the committed work outcome.
    context.complete(output);
    this.#outputSection?.complete(output);
    this.publish({ kind: 'finished', state: context.state });
    return output;
  }
}
