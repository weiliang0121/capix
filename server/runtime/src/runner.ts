import { randomUUID } from 'node:crypto';
import { isUndefined } from 'es-toolkit/predicate';
import { Clock, isInvocationCancelled, type InvocationControls, type CheckpointInstallation } from '@capix/invocation';
import { bindDriverObservation } from './binding/observation.js';
import type { CallableHookBinding } from './binding/hooks.js';
import type { EventConsumer } from '@capix/changes';
import type { DriverFact } from './observation/driver.js';
import type { BuiltCallable } from './structure/construction.js';
import { CallableBuilder } from './structure/builder.js';
import { runEntry, type EntryChange, type EntryState } from './entry.js';
import { snapshotInvocationCapabilities, type InvocationCapabilities } from './construction/capabilities.js';
import { Scene } from '@capix/structure';
import type { CallableInput, CallableOutput, CallableDelta, Stable } from '@capix/contracts';
import type { CheckpointStore } from '@capix/checkpoint';
import { Resources } from './resource/resources.js';
import { Interactions } from '@capix/interaction';
import type { AnyCallable } from './binding/declarations.js';
import { RunnerOutputSubscriptions, type RunnerOutput } from './runner/output.js';
import { RunnerCancellation } from './runner/cancellation.js';
import { RunnerObservationSubscriptions, type RunnerObservation } from './runner/observation.js';
import { RunnerEntryFeedback } from './runner/feedback.js';

export type { RunnerOutput, RunnerOutputEvent } from './runner/output.js';
export type { RunnerObservation, RunnerObservationReceiver } from './runner/observation.js';
export type * from './runner/observation-contract.js';

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
  readonly #checkpoints: CheckpointInstallation | undefined;
  readonly #observation: EventConsumer<DriverFact>;
  #built: BuiltCallable<Structure, Options> | undefined;
  #building = false;
  readonly #entry: EntryState = { running: false };
  readonly #outputs = new RunnerOutputSubscriptions<CallableOutput<Structure>, CallableDelta<Structure>>();
  readonly #observations = new RunnerObservationSubscriptions();
  #cancellation?: RunnerCancellation;
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
    this.#checkpoints = capabilities.checkpoints;
    this.#builder = new CallableBuilder(capabilities);
    this.#observation = bindDriverObservation(this.id, capabilities.observations);
    this.publish({ kind: 'established' });
  }

  get scene(): Structure {
    return this.#scene;
  }

  get checkpointStore(): CheckpointStore | undefined {
    return this.#checkpoints?.store;
  }

  get isRunning(): boolean {
    return this.#entry.running;
  }

  get output(): RunnerOutput<CallableOutput<Structure>, CallableDelta<Structure>> {
    return this.#outputs.port;
  }

  get observation(): RunnerObservation {
    return this.#observations.port;
  }

  /** Request a cooperative stop of the current call; idle or already cancelled returns false. */
  cancel(reason?: unknown): boolean {
    return this.#entry.running ? (this.#cancellation?.cancel(reason) ?? false) : false;
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

  run(input: NoInfer<CallableInput<Structure> | Stable<CallableInput<Structure>>>, ...args: RunnerArguments<Options>): Promise<Stable<CallableOutput<Structure>>> {
    return this.perform({ input }, args[0] ?? ({} as Options & InvocationControls));
  }

  resume(contextId: string, ...args: RunnerArguments<Options>): Promise<Stable<CallableOutput<Structure>>> {
    return this.perform({ contextId }, args[0] ?? ({} as Options & InvocationControls));
  }

  private async perform(request: { input: CallableInput<Structure> | Stable<CallableInput<Structure>> } | { contextId: string }, options: Options & InvocationControls): Promise<Stable<CallableOutput<Structure>>> {
    const feedback = new RunnerEntryFeedback(this.id, this.#observations, this.#clock);
    const mode = 'contextId' in request ? 'resume' : 'run';
    const requestedContextId = 'contextId' in request ? request.contextId : undefined;
    let requested = false;
    let cancellation: RunnerCancellation | undefined;
    let externalSignal: AbortSignal | undefined;
    try {
      // Fix host parameters before any subscription can reenter or change them.
      const fixedOptions = this.snapshotOptions(options);
      requested = true;
      feedback.requested(mode, requestedContextId);
      const structure = this.#built;
      if (!structure) throw new Error('Runner must be built before running');
      let result: Stable<CallableOutput<Structure>>;
      if (this.#entry.running) {
        // A rejected request has feedback, but never takes over active cancellation.
        result = await runEntry(this.#entry, structure, request, fixedOptions, (change) => this.publish(change, feedback));
      } else {
        externalSignal = fixedOptions.signal;
        cancellation = new RunnerCancellation(externalSignal);
        this.#cancellation = cancellation;
        result = await runEntry(this.#entry, structure, request, fixedOptions, (change) => this.publish(change, feedback), {
          signal: cancellation.signal,
          output: this.#outputs.forEntry(feedback.id),
          feedback: feedback.receivers(cancellation.signal),
          created: feedback.created,
        });
      }
      feedback.settled('succeeded');
      return result;
    } catch (error) {
      if (!requested) feedback.requested(mode, requestedContextId);
      const delivered = cancellation ? cancellation.deliveryError(error) : error;
      const cancelled = cancellation && (isInvocationCancelled(delivered, cancellation.signal) || (externalSignal && isInvocationCancelled(delivered, externalSignal)));
      feedback.settled(cancelled ? 'cancelled' : 'failed', delivered);
      throw delivered;
    } finally {
      cancellation?.dispose();
      // A released observer may already have started the next call.
      if (this.#cancellation === cancellation) this.#cancellation = undefined;
    }
  }

  private snapshotOptions(options: Options & InvocationControls): Options & InvocationControls {
    return Object.freeze({ ...options });
  }

  private publish(change: EntryChange, feedback?: RunnerEntryFeedback): void {
    feedback?.entry(change);
    // The existing wire describes host entry facts; the new author name needs no protocol fork.
    const fault = this.#observation.publish(Object.freeze({ ...change, driverId: this.id, sequence: ++this.#sequence, occurredAt: this.#clock.now() }));
    if (!isUndefined(fault)) throw fault;
  }
}
