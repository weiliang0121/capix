import { randomUUID } from 'node:crypto';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock } from './clock.js';
import { bindDriverObservation } from './binding/observation.js';
import type { EventConsumer } from '@capix/changes';
import type { DriverFact } from './observation/facts.js';
import { requireNotCancelled } from './invocation/cancellation.js';
import { RuntimeError } from '@capix/contracts';
import type { AnyBuiltCallable, BuiltCallable, BuiltOptions } from './structure/construction.js';
import { CallableBuilder } from './structure/builder.js';
import { createRootInvocation, restoreRootInvocation } from './invocation/builders/structure.js';
import type { InvocationControls } from './context/context.js';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from './invocation/capabilities.js';
import { type CallableBindingOptions } from './binding/callable.js';
import type { AnyCallable } from './binding/declarations.js';
import type { CallableInput, CallableOutput } from '@capix/contracts';
import type { CheckpointStore } from './checkpoint/contract.js';

type DriverChange = { kind: 'established' } | ({ boundId: string } & ({ kind: 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown }));

/** Host entry coordination; Invocation remains the only owner of a call's semantic progress. */
export class Driver {
  readonly id = randomUUID();
  readonly #entries = new WeakMap<object, { running: boolean }>();
  readonly #builder: CallableBuilder;
  readonly #clock: Clock;
  readonly #checkpointStore: CheckpointStore | undefined;
  readonly #observation: EventConsumer<DriverFact>;
  #sequence = 0;

  constructor(options: InvocationCapabilities = {}) {
    this.#clock = options.clock ?? new Clock();
    const capabilities = snapshotInvocationCapabilities({ ...options, clock: this.#clock });
    this.#checkpointStore = capabilities.checkpoints?.store;
    this.#builder = new CallableBuilder(capabilities);
    this.#observation = bindDriverObservation(this.id, capabilities.observations);
    this.publish({ kind: 'established' });
  }

  get checkpointStore(): CheckpointStore | undefined {
    return this.#checkpointStore;
  }

  build<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): BuiltCallable<Structure, Options> {
    const built = this.#builder.build(structure, options);
    this.#entries.set(built, { running: false });
    return built;
  }

  isRunning(structure: AnyBuiltCallable): boolean {
    return this.entry(structure).running;
  }

  run<Structure extends AnyBuiltCallable>(structure: Structure, input: NoInfer<CallableInput<Structure>>, options: NoInfer<BuiltOptions<Structure>> & InvocationControls): Promise<CallableOutput<Structure>> {
    return this.perform(structure, { input }, options);
  }

  resume<Structure extends AnyBuiltCallable>(structure: Structure, contextId: string, options: NoInfer<BuiltOptions<Structure>> & InvocationControls): Promise<CallableOutput<Structure>> {
    return this.perform(structure, { contextId }, options);
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

  private async perform<Structure extends AnyBuiltCallable>(structure: Structure, request: { input: CallableInput<Structure> } | { contextId: string }, options: BuiltOptions<Structure> & InvocationControls): Promise<CallableOutput<Structure>> {
    const entry = this.entry(structure);
    return await this.reserve(structure.id, entry, () => {
      let invocation;
      try {
        if (options?.signal) requireNotCancelled(options.signal);
        invocation = 'contextId' in request ? restoreRootInvocation(structure, request.contextId, options, options) : createRootInvocation(structure, request.input, options, options);
      } catch (error) {
        try {
          this.publish({ kind: 'entry-failed', boundId: structure.id, error });
        } catch (observation) {
          throw new AggregateError([error, observation], 'Call construction and observation both failed', { cause: error });
        }
        throw error;
      }
      return invocation.run();
    });
  }

  private publish(change: DriverChange): void {
    const fault = this.#observation.publish(Object.freeze({ ...change, driverId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }
}
