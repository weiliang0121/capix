import { randomUUID } from 'node:crypto';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from './clock.js';
import { bindDriverObservation } from './binding/observation.js';
import type { EventConsumer } from './observation/observer.js';
import type { DriverFact } from './observation/facts.js';
import { DeclaredException } from './exception/contract.js';
import { requireNotCancelled } from './invocation/cancellation.js';
import { RuntimeError } from './errors/error.js';
import type { BoundCallable } from './structure/callable.js';
import type { InvocationControls } from './context/context.js';
import type { InvocationCapabilities } from './invocation/capabilities.js';
import { CallableBinder, type CallableBindingOptions } from './binding/callable.js';
import type { AnyCallableDefinition } from './binding/declarations.js';
import type { DefinitionInput, DefinitionOutput } from './definition/signature.js';
import type { ResourcesOf } from './resource/offer.js';
import type { CheckpointStore } from './checkpoint/contract.js';

type DriverChange = { kind: 'established' } | ({ boundId: string } & ({ kind: 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown }));

/** Host entry coordination; Invocation remains the only owner of a call's semantic progress. */
export class Driver {
  readonly id = randomUUID();
  readonly #entries = new WeakMap<object, { running: boolean }>();
  readonly #binder: CallableBinder;
  readonly #clock: Clock;
  readonly #checkpointStore: CheckpointStore | undefined;
  readonly #observation: EventConsumer<DriverFact>;
  #sequence = 0;

  constructor(options: InvocationCapabilities = {}) {
    this.#clock = options.clock ?? new Clock();
    const observations = options.observations ? Object.freeze([...options.observations]) : undefined;
    const checkpointObservation = options.checkpoints?.observation;
    const checkpoints = options.checkpoints
      ? Object.freeze({
          store: options.checkpoints.store,
          observation: checkpointObservation ? Object.freeze({ observe: checkpointObservation.observe.bind(checkpointObservation), failure: checkpointObservation.failure }) : undefined,
        })
      : undefined;
    this.#checkpointStore = checkpoints?.store;
    const capabilities = Object.freeze({ ...options, clock: this.#clock, observations, checkpoints });
    this.#binder = new CallableBinder(capabilities);
    this.#observation = bindDriverObservation(this.id, observations);
    this.publish({ kind: 'established' });
  }

  get checkpointStore(): CheckpointStore | undefined {
    return this.#checkpointStore;
  }

  bind<Definition extends AnyCallableDefinition, Options, Source>(definition: Definition, options: CallableBindingOptions<NoInfer<DefinitionInput<Definition>>, Options, Source>): BoundCallable<DefinitionInput<Definition>, DefinitionOutput<Definition>, ResourcesOf<Definition['run']['requires']>, Options> {
    const bound = this.#binder.bind(definition, options);
    this.#entries.set(bound, { running: false });
    return bound;
  }

  isRunning(bound: BoundCallable<any, any, any, any>): boolean {
    return this.entry(bound).running;
  }

  run<Input, Output, Resources extends object, Options>(bound: BoundCallable<Input, Output, Resources, Options>, input: NoInfer<Input>, options: NoInfer<Options> & InvocationControls): Promise<Output> {
    return this.perform(bound, { input }, options);
  }

  resume<Input, Output, Resources extends object, Options>(bound: BoundCallable<Input, Output, Resources, Options>, contextId: string, options: NoInfer<Options> & InvocationControls): Promise<Output> {
    return this.perform(bound, { contextId }, options);
  }

  private entry(bound: object): { running: boolean } {
    const entry = this.#entries.get(bound);
    if (!entry) throw new RuntimeError('FOREIGN_BINDING', '调用结构不属于当前 Driver。');
    return entry;
  }

  private async reserve<Value>(boundId: string, entry: { running: boolean }, work: () => Value | Promise<Value>): Promise<Value> {
    if (entry.running) {
      const error = new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
      try {
        this.publish({ kind: 'rejected', boundId, reason: 'busy', error });
      } catch (observation) {
        throw new AggregateError([error, observation], 'Entry rejection and observation both failed', { cause: error });
      }
      throw error;
    }
    entry.running = true;
    let failed = false;
    let failure: unknown;
    try {
      this.publish({ kind: 'acquired', boundId });
      return await work();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      entry.running = false;
      try {
        this.publish({ kind: 'released', boundId });
      } catch (observation) {
        if (failed) throw new AggregateError([failure, observation], 'Call delivery and release observation both failed', { cause: failure });
        throw observation;
      }
    }
  }

  private async perform<Input, Output, Resources extends object, Options>(bound: BoundCallable<Input, Output, Resources, Options>, request: { input: Input } | { contextId: string }, options: Options & InvocationControls): Promise<Output> {
    try {
      const entry = this.entry(bound);
      return await this.reserve(bound.id, entry, () => {
        let invocation;
        try {
          if (options?.signal) requireNotCancelled(options.signal);
          const scope = bound.begin(options);
          invocation = 'contextId' in request ? bound.resumeRoot(request.contextId, scope, options) : bound.createRoot(request.input, scope, options);
        } catch (error) {
          try {
            this.publish({ kind: 'entry-failed', boundId: bound.id, error });
          } catch (observation) {
            throw new AggregateError([error, observation], 'Call construction and observation both failed', { cause: error });
          }
          throw error;
        }
        return invocation.run();
      });
    } catch (error) {
      if (error instanceof DeclaredException) throw new RuntimeError('UNHANDLED_EXCEPTION', '运行异常未被接纳处理。', undefined, { cause: error });
      throw error;
    }
  }

  private publish(change: DriverChange): void {
    const fault = this.#observation.publish(Object.freeze({ ...change, driverId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }
}
