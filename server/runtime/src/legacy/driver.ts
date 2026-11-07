import { randomUUID } from 'node:crypto';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock, type InvocationControls } from '@capix/invocation';
import { bindDriverObservation } from '../binding/observation.js';
import type { EventConsumer } from '@capix/changes';
import type { DriverFact } from '../observation/driver.js';
import { RuntimeError } from '@capix/contracts';
import type { AnyBuiltCallable, BuiltCallable, BuiltOptions } from '../structure/construction.js';
import { buildCallableFromSource } from './binding.js';
import { runEntry, type EntryChange, type EntryState } from '../entry.js';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from '../construction/capabilities.js';
import { type CallableBindingOptions } from './binding.js';
import type { AnyCallable } from '../binding/declarations.js';
import type { CallableInput, CallableOutput, Stable } from '@capix/contracts';
import type { CheckpointStore } from '@capix/checkpoint';

/** Legacy multi-root host. New hosts use Runner; both share entry and invocation mechanisms. */
export class Driver {
  readonly id = randomUUID();
  readonly #entries = new WeakMap<object, EntryState>();
  readonly #capabilities: InvocationCapabilities;
  readonly #clock: Clock;
  readonly #checkpointStore: CheckpointStore | undefined;
  readonly #observation: EventConsumer<DriverFact>;
  #sequence = 0;

  constructor(options: InvocationCapabilities = {}) {
    this.#clock = options.clock ?? new Clock();
    const capabilities = snapshotInvocationCapabilities({ ...options, clock: this.#clock });
    this.#checkpointStore = capabilities.checkpoints?.store;
    this.#capabilities = capabilities;
    this.#observation = bindDriverObservation(this.id, capabilities.observations);
    this.publish({ kind: 'established' });
  }

  get checkpointStore(): CheckpointStore | undefined {
    return this.#checkpointStore;
  }

  build<Structure extends AnyCallable, Options, Source>(structure: Structure, options: CallableBindingOptions<NoInfer<CallableInput<Structure>>, Options, Source>): BuiltCallable<Structure, Options> {
    const built = buildCallableFromSource(structure, options, this.#capabilities);
    this.#entries.set(built, { running: false });
    return built;
  }

  isRunning(structure: AnyBuiltCallable): boolean {
    return this.entry(structure).running;
  }

  run<Structure extends AnyBuiltCallable>(structure: Structure, input: NoInfer<CallableInput<Structure> | Stable<CallableInput<Structure>>>, options: NoInfer<BuiltOptions<Structure>> & InvocationControls): Promise<Stable<CallableOutput<Structure>>> {
    return this.perform(structure, { input }, options);
  }

  resume<Structure extends AnyBuiltCallable>(structure: Structure, contextId: string, options: NoInfer<BuiltOptions<Structure>> & InvocationControls): Promise<Stable<CallableOutput<Structure>>> {
    return this.perform(structure, { contextId }, options);
  }

  private entry(bound: object): EntryState {
    const entry = this.#entries.get(bound);
    if (!entry) throw new RuntimeError('FOREIGN_BINDING', '调用结构不属于当前 Driver。');
    return entry;
  }

  private async perform<Structure extends AnyBuiltCallable>(structure: Structure, request: { input: CallableInput<Structure> | Stable<CallableInput<Structure>> } | { contextId: string }, options: BuiltOptions<Structure> & InvocationControls): Promise<Stable<CallableOutput<Structure>>> {
    const entry = this.entry(structure);
    return runEntry(entry, structure, request, options, (change) => this.publish(change));
  }

  private publish(change: EntryChange): void {
    const fault = this.#observation.publish(Object.freeze({ ...change, driverId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }
}
