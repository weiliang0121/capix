import { randomUUID } from 'node:crypto';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock, type InvocationControls } from '@capix/invocation';
import { bindDriverObservation } from './binding/observation.js';
import type { CallableHookBinding } from './binding/hooks.js';
import type { EventConsumer } from '@capix/changes';
import type { DriverFact } from './observation/driver.js';
import type { BuiltCallable } from './structure/construction.js';
import { CallableBuilder } from './structure/builder.js';
import { runEntry, type EntryChange, type EntryState } from './entry.js';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from './construction/capabilities.js';
import { Scene } from '@capix/structure';
import type { CallableInput, CallableOutput } from '@capix/contracts';
import type { CheckpointStore } from '@capix/checkpoint';
import { Resources } from './resource/resources.js';
import { Interactions } from '@capix/interaction';
import type { AnyCallable } from './binding/declarations.js';

export interface RunnerOptions<Options extends object = {}> extends InvocationCapabilities {
  readonly hooks?: readonly CallableHookBinding<Options>[];
  /** Host admission/recovery checks; resource capture is declared through Resources. */
  readonly validate?: (options: Options) => undefined;
}

export type RunnerArguments<Options extends object> = {} extends Options ? [options?: Options & InvocationControls] : [options: Options & InvocationControls];

/** One fixed scene and supply set; build and run do not expose another structural object. */
export class Runner<Structure extends Extract<AnyCallable, { readonly kind: 'scene' }>, Options extends object = {}> {
  readonly id = randomUUID();
  readonly #scene: Structure;
  readonly #resources: Resources<Options>;
  readonly #interactions: Interactions | undefined;
  readonly #options: Pick<RunnerOptions<Options>, 'hooks' | 'validate'>;
  readonly #builder: CallableBuilder;
  readonly #clock: Clock;
  readonly #checkpointStore: CheckpointStore | undefined;
  readonly #observation: EventConsumer<DriverFact>;
  #built: BuiltCallable<Structure, Options> | undefined;
  #building = false;
  readonly #entry: EntryState = { running: false };
  #sequence = 0;

  constructor(scene: Structure, resources: Resources<Options>, interactions?: Interactions, options: RunnerOptions<NoInfer<Options>> = {}) {
    if (!(scene instanceof Scene)) throw new TypeError('Runner requires a Scene');
    if (!(resources instanceof Resources)) throw new TypeError('Runner requires Resources');
    if (interactions !== undefined && !(interactions instanceof Interactions)) throw new TypeError('Runner interactions must be an Interactions instance');
    this.#scene = scene;
    this.#resources = resources;
    this.#interactions = interactions;
    // Membership is fixed here; callback methods are resolved at the build boundary.
    this.#options = Object.freeze({ hooks: options.hooks ? Object.freeze([...options.hooks]) : undefined, validate: options.validate?.bind(options) });
    this.#clock = options.clock ?? new Clock();
    const capabilities = snapshotInvocationCapabilities({ ...options, clock: this.#clock });
    this.#checkpointStore = capabilities.checkpoints?.store;
    this.#builder = new CallableBuilder(capabilities);
    this.#observation = bindDriverObservation(this.id, capabilities.observations);
    this.publish({ kind: 'established' });
  }

  get scene(): Structure {
    return this.#scene;
  }

  get checkpointStore(): CheckpointStore | undefined {
    return this.#checkpointStore;
  }

  get isRunning(): boolean {
    return this.#entry.running;
  }

  build(): this {
    if (this.#built) throw new Error('Runner has already been built');
    if (this.#building) throw new Error('Runner build is already in progress');
    this.#building = true;
    try {
      this.#built = this.#builder.build(this.#scene, this.#resources, this.#interactions, this.#options);
      return this;
    } finally {
      this.#building = false;
    }
  }

  run(input: NoInfer<CallableInput<Structure>>, ...args: RunnerArguments<Options>): Promise<CallableOutput<Structure>> {
    return this.perform({ input }, args[0] ?? ({} as Options & InvocationControls));
  }

  resume(contextId: string, ...args: RunnerArguments<Options>): Promise<CallableOutput<Structure>> {
    return this.perform({ contextId }, args[0] ?? ({} as Options & InvocationControls));
  }

  private async perform(request: { input: CallableInput<Structure> } | { contextId: string }, options: Options & InvocationControls): Promise<CallableOutput<Structure>> {
    // Fix this call's parameter bag before entry observers or host callbacks can run.
    // Resource entities and the cancellation signal retain their original identities.
    const fixedOptions = this.snapshotOptions(options);
    const structure = this.#built;
    if (!structure) throw new Error('Runner must be built before running');
    return runEntry(this.#entry, structure, request, fixedOptions, (change) => this.publish(change));
  }

  private snapshotOptions(options: Options & InvocationControls): Options & InvocationControls {
    return Object.freeze({ ...options });
  }

  private publish(change: EntryChange): void {
    // The existing wire describes host entry facts; the new author name needs no protocol fork.
    const fault = this.#observation.publish(Object.freeze({ ...change, driverId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }
}
