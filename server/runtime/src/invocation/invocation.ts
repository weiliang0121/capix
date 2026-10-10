import { isUndefined } from 'es-toolkit/predicate';
import { RuntimeErrorHelper } from '../errors/helper.js';
import { Clock } from '../runtime/clock.js';
import { DeclaredException } from '../exception/contract.js';
import { InvocationStopped } from './stop.js';
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

/** Synchronous setup after validation, before record registration and work. Throws stop the call unchanged. */
export type InvocationStarted<Input, Output, Context extends InvocationContext<Input, Output>> = (context: Context, invocation: Invocation<Input, Output, Context>) => void;

export interface InvocationOptions<Input, Output, Context extends InvocationContext<Input, Output>> {
  context: Context;
  clock?: Clock;
  parent?: { invocation: ParentInvocation } & InvocationRelationOptions;
  work: InvocationWork<Input, Output, Context>;
  signal: AbortSignal;
  observation?: InvocationObservation;
  identity?: InvocationIdentity;
  description?: InvocationDescription;
  started?: InvocationStarted<Input, Output, Context>;
  /** Side-effect-free guard, checked at setup and before each execute/receive phase. */
  validate?: () => void;
  changes?: InvocationChangeEmitter;
}

/** A single-use structured call owns its Context and progress. Optional observation consumes its typed facts without requiring a particular carrier. */
export class Invocation<Input = unknown, Output = unknown, Context extends InvocationContext<Input, Output> = InvocationContext<Input, Output>> {
  #started = false;
  #sequence = 0;
  #eventSequence = 0;
  #resourceSequence = 0;
  readonly #clock: Clock;
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
    return this.options.observation;
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
    this.children = new InvocationChildren(
      options.context,
      (failure) => {
        if (failure.kind === 'error' && !this.#fault) this.#fault = failure;
      },
      () => this.requireHealthy(),
      (relation, change) => this.publishRelation(relation, change),
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
    this.#parentRelation = options.parent?.invocation.children.attach(this, options.parent);
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

  private publish(change: InvocationChange): void {
    const identity = this.options.identity ?? {
      contextId: this.context.id,
      level: ('level' in this.context ? this.context.level : 'attempt') as InvocationIdentity['level'],
      ...(this.options.parent ? { parentContextId: this.options.parent.invocation.context.id } : {}),
    };
    const fact: InvocationFact = Object.freeze({ ...change, identity, description: this.options.description, eventSequence: ++this.#eventSequence, occurredAt: this.#clock.now(), monotonicTime: this.#clock.tick() });
    const faults: unknown[] = [];
    try {
      let captured;
      if (fact.kind === 'process') captured = { kind: 'process' as const, processSequence: fact.processSequence, round: fact.round, stage: fact.process.stage, action: fact.process.type };
      else if (fact.kind === 'entry') captured = { kind: 'entry' as const, target: fact.target, instanceId: fact.instanceId, ...(fact.key ? { key: fact.key } : {}), stage: fact.stage, status: fact.status, ...(fact.status === 'failed' ? { error: RuntimeErrorHelper.format(fact.error) } : {}) };
      else if (fact.kind === 'relation') captured = { kind: 'relation' as const, identity: fact.relation, phase: fact.change.kind, ...(fact.change.kind === 'returned' ? { status: fact.change.result.status, ...(fact.change.result.status === 'failed' && fact.change.result.failure ? { failure: failureFact(fact.change.result.failure) } : {}) } : {}) };
      else if (fact.kind === 'finished') captured = { kind: 'finished' as const, status: fact.state.status === 'succeeded' ? ('succeeded' as const) : ('failed' as const) };
      else captured = { kind: 'started' as const };
      this.options.changes?.publish(captured, { sequence: fact.eventSequence, occurredAt: fact.occurredAt });
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
      this.publish({ kind: 'started', input: context.input });
      if ('resources' in context) (context.resources as { start(): void }).start();
      output = await cycle(this, this.options.work, {
        signal: this.options.signal,
        validate: this.options.validate,
        onProcess: (process) => this.publish({ kind: 'process', process, processSequence: this.nextSequence(), round: context.progress.round }),
      });
    } catch (error) {
      const failure = this.#classified && this.#classified.error === error ? this.#classified : this.classify(error, context.progress.round ? context.progress.phase : 'setup', true);
      context.fail(error, Object.freeze({ ...failure, error, ...(error instanceof AggregateError ? { kind: 'error' as const } : {}) }));
      try {
        this.publish({ kind: 'finished', state: context.state });
      } catch (observed) {
        throw new AggregateError([error, observed], 'Call failure and its observation both failed', { cause: error });
      }
      throw error;
    }
    // Terminal observation may fail delivery, but never changes the committed work outcome.
    context.complete(output);
    this.publish({ kind: 'finished', state: context.state });
    return output;
  }
}
