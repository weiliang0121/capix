import { isPromise } from 'node:util/types';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { isNonBlankString } from './value.js';
import type { InteractionContract, InteractionOptions, InteractionPersistence, InteractionRead, InteractionState, InteractionWait, InteractionWaitOptions } from './contract.js';
import { Interaction } from './interaction.js';
import { InteractionProgress, unavailableProgressReader, validateProgressLimits } from './progress/buffer.js';
import { ProgressBudget } from './progress/budget.js';
import type { ProgressReceiver } from '@weiliang0121/capix-changes';
import { progressObservation } from './observation.js';
import type { InteractionCursor, InteractionProgressBudgetLimits, InteractionProgressFact, InteractionProgressLimits, InteractionProgressReader, InteractionPublisher } from './progress/types.js';

/** Durable exchange identity. It carries no invocation endpoint or ownership of the sender. */
export interface InteractionReference {
  readonly id: string;
  readonly contract: string;
}

/** A fixed registration's narrow port; resource endpoints add invocation access controls. */
export interface InteractionChannel<Request, Reply, Delta = never> {
  start(request: Request): InteractionReference;
  read(ref: InteractionReference): InteractionRead<Reply>;
  wait(ref: InteractionReference, options: InteractionWaitOptions): Promise<InteractionWait<Reply>>;
  openProgress(ref: InteractionReference, after?: InteractionCursor): InteractionProgressReader<Delta>;
}

export interface InteractionRegistration<Request, Reply, Delta = never> {
  readonly send: (request: Readonly<Request>, progress: InteractionPublisher<Delta>) => Reply | Promise<Reply>;
  readonly progress?: InteractionProgressLimits;
  readonly progressObservation?: ProgressReceiver<InteractionProgressFact>;
  readonly persistence?: InteractionPersistence<Request, Reply> & {
    read?(id: string): InteractionState | undefined;
  };
  readonly observation?: InteractionOptions<Request, Reply>['observation'];
}

interface RegistrationEntry {
  readonly key: string;
  readonly channel: unknown;
  active(): boolean;
  pendingCount(): number;
  settled(): Promise<void>;
  clear(): void;
}

/** Host-owned registrations and exchanges; neither a scheduler nor an invocation lifecycle. */
export class Interactions {
  readonly #registrations = new Map<object, RegistrationEntry>();
  readonly #keys = new Set<string>();
  readonly #retained: number;
  readonly #progressBudget: ProgressBudget;
  #closed = false;

  constructor(options: { readonly retained?: number; readonly progress?: InteractionProgressBudgetLimits } = {}) {
    this.#retained = options.retained ?? 128;
    if (!Number.isSafeInteger(this.#retained) || this.#retained < 1) throw new RangeError('Interaction retention must be a positive integer');
    this.#progressBudget = new ProgressBudget(options.progress);
  }

  /** Register a contract and its host implementation without creating or dispatching an exchange. */
  register<Request, Reply, Delta = never>(contract: InteractionContract<Request, Reply, Delta>, registration: InteractionRegistration<NoInfer<Request>, NoInfer<Reply>, NoInfer<Delta>>): this {
    this.requireOpen();
    if (!isNonBlankString(contract.key) || typeof contract.request !== 'function' || typeof contract.reply !== 'function') throw new TypeError('Interaction registration requires a valid contract');
    if (this.#registrations.has(contract) || this.#keys.has(contract.key)) throw new RuntimeError('INTERACTION_ALREADY_REGISTERED', 'Interaction identity and key can each be registered only once');
    const registered = new RegisteredInteractions(contract, registration, this.#retained, () => this.requireOpen(), this.#progressBudget);
    this.#registrations.set(contract, {
      key: contract.key,
      channel: registered.channel,
      active: () => registered.active,
      pendingCount: () => registered.pendingCount,
      settled: () => registered.settled(),
      clear: () => registered.clear(),
    });
    this.#keys.add(contract.key);
    return this;
  }

  /** Resolve exact contract identity during construction. The resulting channel never changes. */
  bind<Request, Reply, Delta = never>(contract: InteractionContract<Request, Reply, Delta>): InteractionChannel<Request, Reply, Delta> {
    this.requireOpen();
    const registration = this.#registrations.get(contract);
    if (!registration) throw new RuntimeError(this.#keys.has(contract.key) ? 'INTERACTION_CONTRACT_IDENTITY' : 'INTERACTION_NOT_REGISTERED', 'The exact interaction contract must be registered before it is bound');
    if (registration.key !== contract.key) throw new RuntimeError('INTERACTION_CONTRACT_CHANGED', 'A registered interaction contract key cannot change');
    // register stores this channel under the same contract object carrying Request/Reply.
    return registration.channel as InteractionChannel<Request, Reply, Delta>;
  }

  get active(): boolean {
    return [...this.#registrations.values()].some((registration) => registration.active());
  }

  /** Installed live exchanges that have not settled, including feedback validation and persistence.
   * Preparation before installation and read-only restoration are excluded; active still protects preparation.
   */
  get pendingCount(): number {
    let count = 0;
    for (const registration of this.#registrations.values()) count += registration.pendingCount();
    return count;
  }

  /** Join host-owned sends. Ending a resource access window never invokes this method. */
  async settled(): Promise<void> {
    while (this.active) await Promise.all([...this.#registrations.values()].map((registration) => registration.settled()));
  }

  /** Explicit host shutdown; active sends cannot be abandoned or cancelled here. */
  close(): void {
    if (this.active) throw new RuntimeError('INTERACTIONS_ACTIVE', 'Cannot close interactions while exchanges are active');
    this.#closed = true;
    for (const registration of this.#registrations.values()) registration.clear();
    this.#registrations.clear();
    this.#keys.clear();
  }

  private requireOpen(): void {
    if (this.#closed) throw new RuntimeError('INTERACTIONS_CLOSED', 'Interactions are closed');
  }
}

/** One fixed contract registration owns its active exchanges and a bounded completed cache. */
class RegisteredInteractions<Request, Reply, Delta> {
  readonly channel: InteractionChannel<Request, Reply, Delta>;
  readonly #options: InteractionOptions<Request, Reply>;
  readonly #send: InteractionRegistration<Request, Reply, Delta>['send'];
  readonly #decodeProgress?: (value: unknown) => Delta;
  readonly #progressLimits: InteractionProgressLimits;
  readonly #progressObservation?: ProgressReceiver<InteractionProgressFact>;
  readonly #read?: (id: string) => InteractionState | undefined;
  readonly #exchanges = new Map<string, { interaction: Interaction<Request, Reply>; progress?: InteractionProgress<Delta> }>();
  readonly #active = new Set<Interaction<Request, Reply>>();
  #preparing = 0;
  #pruning = false;

  constructor(
    contract: InteractionContract<Request, Reply, Delta>,
    registration: InteractionRegistration<Request, Reply, Delta>,
    private readonly retained: number,
    private readonly requireOpen: () => void,
    private readonly progressBudget: ProgressBudget,
  ) {
    if (typeof registration.send !== 'function') throw new TypeError('Interaction registration requires a sender');
    if (contract.progress !== undefined && typeof contract.progress !== 'function') throw new TypeError('Interaction progress requires a synchronous decoder');
    if (registration.progress && !contract.progress) throw new TypeError('Progress limits require an interaction progress contract');
    this.#decodeProgress = contract.progress?.bind(contract);
    this.#progressLimits = validateProgressLimits(registration.progress);
    this.#progressObservation = progressObservation(registration.progressObservation);
    const persistence = registration.persistence;
    if (persistence && (typeof persistence.create !== 'function' || typeof persistence.commit !== 'function' || (persistence.read !== undefined && typeof persistence.read !== 'function'))) throw new TypeError('Interaction registration requires synchronous persistence methods');
    this.#send = registration.send.bind(registration);
    this.#read = persistence?.read?.bind(persistence);
    const observation = registration.observation;
    this.#options = Object.freeze({
      contract: Object.freeze({ key: contract.key, request: contract.request.bind(contract), reply: contract.reply.bind(contract) }),
      ...(persistence ? { persistence: Object.freeze({ create: persistence.create.bind(persistence), commit: persistence.commit.bind(persistence) }) } : {}),
      ...(observation ? { observation: Object.freeze({ receive: observation.receive.bind(observation), ...(observation.failed ? { failed: observation.failed.bind(observation) } : {}) }) } : {}),
    });
    this.channel = Object.freeze({
      start: (request: Request) => this.start(request),
      read: (ref: InteractionReference) => this.get(ref).interaction.read(),
      wait: async (ref: InteractionReference, options: InteractionWaitOptions) => this.get(ref).interaction.wait(options),
      openProgress: (ref: InteractionReference, after?: InteractionCursor) => {
        this.requireReference(ref);
        // Transient process data is never reconstructed from a persisted final reply.
        return this.#exchanges.get(ref.id)?.progress?.open(after) ?? unavailableProgressReader<Delta>(ref.id, this.#decodeProgress ? 'not-retained' : 'not-enabled', after);
      },
    });
  }

  get active(): boolean {
    return this.#preparing > 0 || this.#active.size > 0;
  }

  get pendingCount(): number {
    return this.#active.size;
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#active].map((interaction) => interaction.settled()));
  }

  clear(): void {
    for (const entry of this.#exchanges.values()) entry.progress?.invalidate('closed');
    this.#exchanges.clear();
  }

  private start(request: Request): InteractionReference {
    this.requireOpen();
    this.#preparing += 1;
    let interaction: Interaction<Request, Reply> | undefined;
    let progress: InteractionProgress<Delta> | undefined;
    try {
      // Preparation also counts as activity: persistence/observation callbacks cannot close us.
      interaction = new Interaction(request, this.#options);
      if (this.#decodeProgress) progress = new InteractionProgress(interaction.id, this.#decodeProgress, this.#progressLimits, this.progressBudget, this.#progressObservation);
      this.#exchanges.set(interaction.id, { interaction, progress });
      this.#active.add(interaction);
      progress?.installed();
      const output = progress;
      const publisher: InteractionPublisher<Delta> = Object.freeze({ publish: (value: Delta) => output?.publish(value) ?? Object.freeze({ kind: 'unavailable' as const, reason: 'not-enabled' }) });
      interaction.start(async (request) => {
        try {
          return await this.#send(request, publisher);
        } finally {
          // Sender exit seals process data before final reply validation/persistence.
          output?.seal();
        }
      });
      const started = interaction;
      void started.settled().then(() => {
        this.#active.delete(started);
        this.prune();
      });
      return Object.freeze({ id: interaction.id, contract: this.#options.contract.key });
    } catch (error) {
      progress?.invalidate('start-failed');
      if (interaction) this.#active.delete(interaction);
      this.prune();
      throw error;
    } finally {
      this.#preparing -= 1;
    }
  }

  private get(ref: InteractionReference): { interaction: Interaction<Request, Reply>; progress?: InteractionProgress<Delta> } {
    this.requireReference(ref);
    let entry = this.#exchanges.get(ref.id);
    if (!entry) {
      let saved: InteractionState | undefined;
      try {
        saved = this.#read?.(ref.id);
        if (isPromise(saved)) {
          void saved.catch(() => undefined);
          throw new TypeError('Interaction persistence reads must be synchronous');
        }
      } catch (cause) {
        throw new PersistenceError('interaction.read', cause);
      }
      this.requireOpen();
      if (saved !== undefined) {
        // Restore checks the persisted contract and codecs; no sender is reconstructed.
        try {
          const interaction = Interaction.restore(saved, this.#options);
          if (interaction.id !== ref.id) throw new RuntimeError('INTERACTION_IDENTITY', 'Saved interaction does not match the requested identity');
          entry = { interaction };
        } catch (cause) {
          throw new PersistenceError('interaction.restore', cause);
        }
        this.requireOpen();
        this.#exchanges.set(entry.interaction.id, entry);
        this.prune();
      }
    }
    if (!entry) throw new RuntimeError('INTERACTION_UNKNOWN', 'Interaction is not retained or persisted; it cannot be sent again from a reference');
    return entry;
  }

  private requireReference(ref: InteractionReference): void {
    this.requireOpen();
    if (!ref || !isNonBlankString(ref.id) || ref.contract !== this.#options.contract.key) throw new RuntimeError('INTERACTION_CONTRACT_MISMATCH', 'Interaction reference must belong to this registered contract');
  }

  private prune(): void {
    if (this.#pruning) return;
    this.#pruning = true;
    try {
      for (const [id, entry] of this.#exchanges) {
        if (this.#exchanges.size - this.#active.size <= this.retained) return;
        if (this.#active.has(entry.interaction)) continue;
        this.#exchanges.delete(id);
        // Reentrant observers see the installed eviction, and cannot run a second prune.
        entry.progress?.invalidate('evicted');
      }
    } finally {
      this.#pruning = false;
    }
  }
}
