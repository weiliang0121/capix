import { isPromise } from 'node:util/types';
import { RuntimeError } from '../errors/error.js';
import { isNonBlankString } from '../value/string.js';
import type { InteractionContract, InteractionOptions, InteractionPersistence, InteractionRead, InteractionState, InteractionWait, InteractionWaitOptions } from './contract.js';
import { Interaction } from './interaction.js';

/** Durable exchange identity. It carries no invocation endpoint or ownership of the sender. */
export interface InteractionReference {
  readonly id: string;
  readonly contract: string;
}

/** A fixed registration's narrow port; resource endpoints add invocation access controls. */
export interface InteractionChannel<Request, Reply> {
  start(request: Request): InteractionReference;
  read(ref: InteractionReference): InteractionRead<Reply>;
  wait(ref: InteractionReference, options: InteractionWaitOptions): Promise<InteractionWait<Reply>>;
}

export interface InteractionRegistration<Request, Reply> {
  readonly send: (request: Readonly<Request>) => Reply | Promise<Reply>;
  readonly persistence?: InteractionPersistence<Request, Reply> & {
    read?(id: string): InteractionState | undefined;
  };
  readonly observation?: InteractionOptions<Request, Reply>['observation'];
}

interface RegistrationEntry {
  readonly key: string;
  readonly channel: unknown;
  active(): boolean;
  settled(): Promise<void>;
  clear(): void;
}

/** Host-owned registrations and exchanges; neither a scheduler nor an invocation lifecycle. */
export class Interactions {
  readonly #registrations = new Map<object, RegistrationEntry>();
  readonly #keys = new Set<string>();
  readonly #retained: number;
  #closed = false;

  constructor(options: { readonly retained?: number } = {}) {
    this.#retained = options.retained ?? 128;
    if (!Number.isSafeInteger(this.#retained) || this.#retained < 1) throw new RangeError('Interaction retention must be a positive integer');
  }

  /** Register a contract and its host implementation without creating or dispatching an exchange. */
  register<Request, Reply>(contract: InteractionContract<Request, Reply>, registration: InteractionRegistration<Request, Reply>): this {
    this.requireOpen();
    if (!isNonBlankString(contract.key) || typeof contract.request !== 'function' || typeof contract.reply !== 'function') throw new TypeError('Interaction registration requires a valid contract');
    if (this.#registrations.has(contract) || this.#keys.has(contract.key)) throw new RuntimeError('INTERACTION_ALREADY_REGISTERED', 'Interaction identity and key can each be registered only once');
    const registered = new RegisteredInteractions(contract, registration, this.#retained, () => this.requireOpen());
    this.#registrations.set(contract, {
      key: contract.key,
      channel: registered.channel,
      active: () => registered.active,
      settled: () => registered.settled(),
      clear: () => registered.clear(),
    });
    this.#keys.add(contract.key);
    return this;
  }

  /** Resolve exact contract identity during construction. The resulting channel never changes. */
  bind<Request, Reply>(contract: InteractionContract<Request, Reply>): InteractionChannel<Request, Reply> {
    this.requireOpen();
    const registration = this.#registrations.get(contract);
    if (!registration) throw new RuntimeError(this.#keys.has(contract.key) ? 'INTERACTION_CONTRACT_IDENTITY' : 'INTERACTION_NOT_REGISTERED', 'The exact interaction contract must be registered before it is bound');
    if (registration.key !== contract.key) throw new RuntimeError('INTERACTION_CONTRACT_CHANGED', 'A registered interaction contract key cannot change');
    // register stores this channel under the same contract object carrying Request/Reply.
    return registration.channel as InteractionChannel<Request, Reply>;
  }

  get active(): boolean {
    return [...this.#registrations.values()].some((registration) => registration.active());
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
class RegisteredInteractions<Request, Reply> {
  readonly channel: InteractionChannel<Request, Reply>;
  readonly #options: InteractionOptions<Request, Reply>;
  readonly #send: InteractionRegistration<Request, Reply>['send'];
  readonly #read?: (id: string) => InteractionState | undefined;
  readonly #exchanges = new Map<string, Interaction<Request, Reply>>();
  readonly #active = new Set<Interaction<Request, Reply>>();
  #preparing = 0;

  constructor(
    contract: InteractionContract<Request, Reply>,
    registration: InteractionRegistration<Request, Reply>,
    private readonly retained: number,
    private readonly requireOpen: () => void,
  ) {
    if (typeof registration.send !== 'function') throw new TypeError('Interaction registration requires a sender');
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
      read: (ref: InteractionReference) => this.get(ref).read(),
      wait: async (ref: InteractionReference, options: InteractionWaitOptions) => this.get(ref).wait(options),
    });
  }

  get active(): boolean {
    return this.#preparing > 0 || this.#active.size > 0;
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#active].map((interaction) => interaction.settled()));
  }

  clear(): void {
    this.#exchanges.clear();
  }

  private start(request: Request): InteractionReference {
    this.requireOpen();
    this.#preparing += 1;
    let interaction: Interaction<Request, Reply> | undefined;
    try {
      // Preparation also counts as activity: persistence/observation callbacks cannot close us.
      interaction = new Interaction(request, this.#options);
      this.#exchanges.set(interaction.id, interaction);
      this.#active.add(interaction);
      interaction.start(this.#send);
      const started = interaction;
      void started.settled().then(() => {
        this.#active.delete(started);
        this.prune();
      });
      return Object.freeze({ id: interaction.id, contract: this.#options.contract.key });
    } catch (error) {
      if (interaction) this.#active.delete(interaction);
      this.prune();
      throw error;
    } finally {
      this.#preparing -= 1;
    }
  }

  private get(ref: InteractionReference): Interaction<Request, Reply> {
    this.requireOpen();
    if (!ref || !isNonBlankString(ref.id) || ref.contract !== this.#options.contract.key) throw new RuntimeError('INTERACTION_CONTRACT_MISMATCH', 'Interaction reference must belong to this registered contract');
    let interaction = this.#exchanges.get(ref.id);
    if (!interaction) {
      const saved = this.#read?.(ref.id);
      if (isPromise(saved)) {
        void saved.catch(() => undefined);
        throw new TypeError('Interaction persistence reads must be synchronous');
      }
      this.requireOpen();
      if (saved !== undefined) {
        // Restore checks the persisted contract and codecs; no sender is reconstructed.
        interaction = Interaction.restore(saved, this.#options);
        this.requireOpen();
        if (interaction.id !== ref.id) throw new RuntimeError('INTERACTION_IDENTITY', 'Saved interaction does not match the requested identity');
        this.#exchanges.set(interaction.id, interaction);
        this.prune();
      }
    }
    if (!interaction) throw new RuntimeError('INTERACTION_UNKNOWN', 'Interaction is not retained or persisted; it cannot be sent again from a reference');
    return interaction;
  }

  private prune(): void {
    let completed = this.#exchanges.size - this.#active.size;
    for (const [id, interaction] of this.#exchanges) {
      if (completed <= this.retained) return;
      if (this.#active.has(interaction)) continue;
      this.#exchanges.delete(id);
      completed -= 1;
    }
  }
}
