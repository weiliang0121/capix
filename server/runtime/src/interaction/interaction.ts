import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../errors/error.js';
import { RuntimeErrorHelper } from '../errors/helper.js';
import { isNonBlankString } from '../value/string.js';
import type { InteractionFeedback, InteractionOptions, InteractionRead, InteractionState, InteractionWait, InteractionWaitOptions } from './contract.js';
import { captureInteractionValue, sameInteractionValue } from './value.js';

/** One fixed external exchange. Invocation waiters neither own its delivery nor consume its reply. */
export class Interaction<Request, Reply> {
  #state: InteractionState<Request, Reply>;
  readonly #options: InteractionOptions<Request, Reply>;
  readonly #listeners = new Set<() => void>();
  #settled: Promise<void> = Promise.resolve();
  #fault?: { readonly error: unknown };
  #deliveryFailure?: { readonly error: unknown };
  #mutating = false;
  #restored = false;

  constructor(request: Request, options: InteractionOptions<Request, Reply>) {
    if (!isNonBlankString(options.contract.key)) throw new TypeError('Interaction contract key must be nonempty');
    this.#options = Object.freeze({ ...options, contract: Object.freeze({ key: options.contract.key, request: options.contract.request.bind(options.contract), reply: options.contract.reply.bind(options.contract) }) });
    const captured = captureInteractionValue(request);
    this.#state = Object.freeze({ id: randomUUID(), contract: this.#options.contract.key, revision: 0, request: captureInteractionValue(this.#options.contract.request(captured)), delivery: 'prepared' });
    const committed: unknown = this.#options.persistence?.create(this.#state);
    if (committed !== undefined) {
      void Promise.resolve(committed).catch(() => undefined);
      throw new TypeError('Interaction persistence must be synchronous');
    }
  }

  get id(): string {
    return this.#state.id;
  }

  exportState(): InteractionState<Request, Reply> {
    return this.#state;
  }

  /** Restored facts are readable, but no running sender or receiver is reconstructed. */
  static restore<Request, Reply>(state: InteractionState, options: InteractionOptions<Request, Reply>): Interaction<Request, Reply> {
    const saved = captureInteractionValue(state);
    const allowed = new Set(['id', 'contract', 'revision', 'request', 'delivery', 'feedback', 'failure']);
    if (Object.keys(saved).some((key) => !allowed.has(key)) || !Object.hasOwn(saved, 'request') || (Object.hasOwn(saved, 'feedback') && !saved.feedback) || (Object.hasOwn(saved, 'failure') && !saved.failure)) throw new TypeError('Invalid persisted interaction fields');
    if (!isNonBlankString(saved.id) || saved.contract !== options.contract.key || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || (saved.delivery !== 'prepared' && saved.delivery !== 'started')) throw new TypeError('Invalid persisted interaction identity or delivery');
    const expectedRevision = (saved.delivery === 'started' ? 1 : 0) + (saved.feedback ? 1 : 0) + (saved.failure ? 1 : 0);
    if (saved.revision !== expectedRevision || (saved.delivery === 'prepared' && (saved.feedback || saved.failure))) throw new TypeError('Invalid persisted interaction progress');
    if (saved.feedback && !isNonBlankString(saved.feedback.id)) throw new TypeError('Invalid persisted interaction feedback identity');
    if (saved.failure && (!isNonBlankString(saved.failure.code) || typeof saved.failure.message !== 'string')) throw new TypeError('Invalid persisted interaction diagnostic');
    const interaction = new Interaction(saved.request as Request, { contract: options.contract });
    const request = interaction.#state.request;
    if (!sameInteractionValue(request, saved.request)) throw new TypeError('Persisted interaction request does not match its contract');
    const feedback = saved.feedback ? Object.freeze({ id: saved.feedback.id, payload: captureInteractionValue(options.contract.reply(saved.feedback.payload)) }) : undefined;
    if (feedback && !sameInteractionValue(feedback.payload, saved.feedback!.payload)) throw new TypeError('Persisted interaction feedback does not match its contract');
    interaction.#state = Object.freeze({ id: saved.id, contract: saved.contract, revision: saved.revision, request, delivery: saved.delivery, ...(feedback ? { feedback } : {}), ...(saved.failure ? { failure: saved.failure } : {}) });
    interaction.#restored = true;
    if (saved.failure) interaction.#deliveryFailure = { error: new RuntimeError(saved.failure.code, saved.failure.message, saved.failure) };
    return interaction;
  }

  /** Commit dispatch intent before invoking the host-owned sender. This method never retries. */
  start(dispatch: (request: Readonly<Request>) => Reply | Promise<Reply>): void {
    this.requireMutable();
    if (this.#state.delivery !== 'prepared') throw new RuntimeError('INTERACTION_ALREADY_STARTED', 'This interaction has already started');
    this.commit(Object.freeze({ ...this.#state, revision: this.#state.revision + 1, delivery: 'started' }));
    this.#settled = Promise.resolve()
      .then(() => dispatch(this.#state.request))
      .then(
        (payload) => {
          try {
            this.receive({ id: randomUUID(), payload });
          } catch (error) {
            if (this.#fault) throw error;
            this.fail(error);
          }
        },
        (error) => this.fail(error),
      )
      .catch((error: unknown) => {
        if (!this.#state.feedback) this.#fault = { error };
        this.notify();
      });
  }

  /** Nondestructive feedback admission; repeated identical delivery is a no-op. */
  receive(feedback: InteractionFeedback<Reply>): void {
    this.requireMutable();
    if (this.#state.delivery !== 'started') throw new RuntimeError('INTERACTION_NOT_STARTED', 'An unstarted interaction cannot receive feedback');
    const captured = captureInteractionValue(feedback);
    if (!isNonBlankString(captured.id)) throw new TypeError('Interaction feedback identity must be nonempty');
    const accepted = Object.freeze({ id: captured.id, payload: captureInteractionValue(this.#options.contract.reply(captured.payload)) });
    if (this.#state.feedback) {
      if (this.#state.feedback.id === accepted.id && sameInteractionValue(this.#state.feedback.payload, accepted.payload)) return;
      throw new RuntimeError('INTERACTION_FEEDBACK_CONFLICT', 'Interaction feedback cannot replace a previously received reply');
    }
    this.commit(Object.freeze({ ...this.#state, revision: this.#state.revision + 1, feedback: accepted }));
    this.notify();
  }

  read(): InteractionRead<Reply> {
    if (this.#fault) return { kind: 'unavailable', error: this.#fault.error };
    if (this.#state.feedback) return { kind: 'received', feedback: this.#state.feedback };
    if (this.#deliveryFailure) return { kind: 'unavailable', error: this.#deliveryFailure.error };
    if (this.#restored) return { kind: 'unavailable', error: new RuntimeError('INTERACTION_RESTORED_PENDING', 'Saved interaction has no received reply and no active delivery owner') };
    return { kind: 'pending' };
  }

  /** The deadline and abort signal belong only to this wait, never to the external sender. */
  wait(options: InteractionWaitOptions): Promise<InteractionWait<Reply>> {
    if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 2_147_483_647) return Promise.reject(new RangeError('Interaction waitMs must be a nonnegative timer duration'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const current = this.read();
    if (current.kind !== 'pending') return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.#listeners.delete(check);
        options.signal?.removeEventListener('abort', cancel);
      };
      const finish = (result: InteractionWait<Reply>) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };
      const cancel = () => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(options.signal?.reason);
      };
      const check = () => {
        const result = this.read();
        if (result.kind !== 'pending') finish(result);
      };
      this.#listeners.add(check);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      if (!finished) check();
      if (!finished) {
        timer = setTimeout(() => {
          check();
          if (!finished) finish({ kind: 'wait-expired' });
        }, options.waitMs);
      }
    });
  }

  /** Join host delivery cleanup. Errors remain available through read(), without unhandled rejections. */
  settled(): Promise<void> {
    return this.#settled;
  }

  private fail(error: unknown): void {
    if (this.#state.feedback) return;
    const failure = captureInteractionValue(RuntimeErrorHelper.format(error));
    this.commit(Object.freeze({ ...this.#state, revision: this.#state.revision + 1, failure }));
    this.#deliveryFailure = { error };
    this.notify();
  }

  private requireMutable(): void {
    if (this.#restored) throw new RuntimeError('INTERACTION_RESTORED', 'Restored interactions are read-only and cannot be sent again');
    if (this.#fault) throw this.#fault.error;
    if (this.#mutating) throw new RuntimeError('INTERACTION_REENTRANT_MUTATION', 'Interaction mutation cannot reenter persistence');
  }

  private commit(state: InteractionState<Request, Reply>): void {
    this.requireMutable();
    this.#mutating = true;
    try {
      const committed: unknown = this.#options.persistence?.commit(Object.freeze({ expectedRevision: this.#state.revision, state }));
      if (committed !== undefined) {
        void Promise.resolve(committed).catch(() => undefined);
        throw new TypeError('Interaction persistence must be synchronous');
      }
      this.#state = state;
    } catch (error) {
      this.#fault = { error };
      this.notify();
      throw error;
    } finally {
      this.#mutating = false;
    }
  }

  private notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
