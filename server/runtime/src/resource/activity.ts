import { isUndefined } from 'es-toolkit/predicate';
import { randomUUID } from 'node:crypto';
import type { TranscriptEvent, MemoryEvent } from '@capix/protocol';
import type { EventConsumer } from '../observation/observer.js';
import type { ResourceObservation } from '../observation/facts.js';
import { RuntimeErrorHelper } from '../errors/helper.js';
import type { OperationOptions, OperationOutcome, OperationResult } from '../operation/contract.js';
import { receiveOperation } from '../operation/receive.js';
import { isProtectedOperationFailure } from '../operation/failure.js';
import type { ResourceOperation } from './methods.js';

/** Internal call binding only. Business receives the resource endpoint, never this provenance port. */
export interface ResourceOwner {
  readonly contextId: string;
  readonly signal?: AbortSignal;
  readonly round?: () => number;
  readonly reception?: () => Readonly<{ parentContextId: string; childContextId: string }>;
  readonly nextSequence?: () => number;
  readonly observation?: EventConsumer<ResourceObservation>;
  readonly transcript?: EventConsumer<TranscriptEvent>;
  readonly memory?: EventConsumer<MemoryEvent>;
  readonly validate: () => void;
  readonly error?: (error: unknown, allowException?: boolean) => void;
}
export interface ResourceInteractionDescription<Output> {
  readonly input?: () => unknown;
  readonly output?: (result: Output) => unknown;
}

/** Per-call local order and fact owner; sharing a supply never shares this session. */
export class ResourceSession {
  #sequence = 0;
  constructor(
    readonly owner?: ResourceOwner,
    private readonly restriction?: () => void,
    private readonly parent?: ResourceSession,
  ) {}
  scope(validate: () => void): ResourceSession {
    return new ResourceSession(this.owner, validate, this);
  }
  error(error: unknown, allowException = false): void {
    this.owner?.error?.(error, allowException);
  }
  /** Check before owning a competing failure, so an already-failed operation is not erased by cancellation. */
  checkWindow(): void {
    if (this.parent) this.parent.checkWindow();
    else this.owner?.validate();
    this.restriction?.();
  }
  validate(): void {
    try {
      this.checkWindow();
    } catch (error) {
      this.error(error);
      throw error;
    }
  }
  publish(access: string, supplyId: string, phase: ResourceObservation['phase'], describe: () => unknown, interactionId?: string): void {
    if (this.parent) return this.parent.publish(access, supplyId, phase, describe, interactionId);
    const owner = this.owner;
    if (!owner) return;
    const fact: ResourceObservation = Object.freeze({ contextId: owner.contextId, access, supplyId, sequence: owner.nextSequence ? owner.nextSequence() : ++this.#sequence, occurredAt: new Date().toISOString(), phase, ...(interactionId ? { interactionId } : {}), describe });
    const error = owner.observation?.publish(fact);
    if (!isUndefined(error)) {
      this.error(error);
      throw error;
    }
  }
}

/** Narrow internal instrumentation provided to a resource's access adapter. */
export class ResourceActivity {
  constructor(
    private readonly session: ResourceSession,
    readonly access: string,
    readonly supplyId: string,
  ) {}
  get origin(): { readonly contextId: string } | undefined {
    const owner = this.session.owner;
    return owner ? Object.freeze({ contextId: owner.contextId }) : undefined;
  }
  validate(): void {
    this.session.validate();
  }
  reception(): Readonly<{ parentContextId: string; childContextId: string }> {
    this.validate();
    if (!this.session.owner?.reception) throw new Error('Fixed operations require a parent reception binding');
    return this.session.owner.reception();
  }
  get transcriptObservation(): EventConsumer<TranscriptEvent> | undefined {
    return this.session.owner?.transcript;
  }
  get memoryObservation(): EventConsumer<MemoryEvent> | undefined {
    return this.session.owner?.memory;
  }
  bound(): void {
    this.publish('bound', () => null);
  }
  available(describe: () => unknown): void {
    this.publish('available', describe);
  }
  unavailable(error: unknown): void {
    this.session.error(error);
    this.publish('unavailable', () => ({ error: RuntimeErrorHelper.format(error) }));
  }

  /** Produce an outcome before receiving it; infrastructure failures never enter business failure reception. */
  async operate<Output, Delta = never, const Options extends OperationOptions<Output, unknown, unknown, Delta> = {}>(action: string, detail: ResourceInteractionDescription<Output>, execute: (operation: ResourceOperation<Delta>) => Output | PromiseLike<Output>, options?: Options): Promise<OperationResult<Output, Options>> {
    this.validate();
    try {
      if (options?.delta !== undefined && typeof options.delta !== 'function') throw new TypeError('Delta receiver must be a function');
      if (options?.result?.succeeded !== undefined && typeof options.result.succeeded !== 'function') throw new TypeError('Success receiver must be a function');
      if (options?.result?.failed !== undefined && typeof options.result.failed !== 'function') throw new TypeError('Failure receiver must be a function');
    } catch (error) {
      this.session.error(error);
      throw error;
    }
    const receiver = options?.result;
    const succeeded = receiver?.succeeded?.bind(receiver);
    const failed = receiver?.failed?.bind(receiver);
    const reception = options ? { ...options, result: { succeeded, failed } } : options;
    const interactionId = randomUUID();
    this.publish('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    this.validate();
    let open = true;
    let consume = options?.delta?.bind(options);
    const operation: ResourceOperation<Delta> = Object.freeze({
      signal: this.session.owner?.signal,
      emit: (delta: Delta) => {
        if (!open) {
          const error = new Error('Resource operation output is closed');
          this.session.error(error);
          throw error;
        }
        this.validate();
        if (!consume) return;
        try {
          const result: unknown = consume(delta);
          // Consumers are passive. A rejected async consumer is detached just like a thrown one.
          if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as PromiseLike<unknown>).then === 'function') {
            void Promise.resolve(result).catch(() => {
              consume = undefined;
            });
          }
        } catch {
          consume = undefined;
        }
      },
    });
    let outcome: OperationOutcome<Output>;
    try {
      outcome = { status: 'succeeded', value: await execute(operation) };
    } catch (failure) {
      outcome = { status: 'failed', failure };
    } finally {
      open = false;
      consume = undefined;
    }
    if (outcome.status === 'succeeded') {
      // A successful source cannot publish a result through an expired window.
      this.validate();
      const value = outcome.value;
      this.publish('returned', () => ({ action, output: detail.output?.(value) ?? null }), interactionId);
    } else {
      const failure = outcome.failure;
      try {
        this.session.checkWindow();
      } catch (windowFailure) {
        // Both facts exist. Keep the original operation fault, and do not run a
        // business receiver after cancellation or closure of its access window.
        const combined = windowFailure === failure ? failure : new AggregateError([failure, windowFailure], 'Resource operation failed after its access window became unavailable', { cause: failure });
        this.failed(action, interactionId, combined);
        throw combined;
      }
      if (isProtectedOperationFailure(failure) || !failed) {
        this.failed(action, interactionId, failure);
        throw failure;
      }
      // Record the real failed operation even when its caller can handle that outcome.
      try {
        this.publish('threw', () => ({ action, error: RuntimeErrorHelper.format(failure) }), interactionId);
      } catch (observation) {
        throw new AggregateError([failure, observation], 'Resource operation and failure observation both failed', { cause: failure });
      }
    }
    try {
      const result = await receiveOperation<Output, unknown, Options>(outcome, reception);
      this.validate();
      return result;
    } catch (error) {
      this.session.error(error, true);
      throw error;
    }
  }

  runSync<Output>(action: string, detail: ResourceInteractionDescription<Output>, execute: () => Output): Output {
    this.validate();
    const interactionId = randomUUID();
    this.publish('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    let output: Output;
    try {
      this.validate();
      output = execute();
    } catch (error) {
      this.failed(action, interactionId, error);
      throw error;
    }
    // Registration failure here must not be mistaken for an operation failure or retry it.
    this.publish('returned', () => ({ action, output: detail.output?.(output) ?? null }), interactionId);
    return output;
  }

  async runAsync<Output>(action: string, detail: ResourceInteractionDescription<Output>, execute: () => Promise<Output>): Promise<Output> {
    this.validate();
    const interactionId = randomUUID();
    this.publish('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    let output: Output;
    try {
      this.validate();
      output = await execute();
    } catch (error) {
      this.failed(action, interactionId, error);
      throw error;
    }
    this.publish('returned', () => ({ action, output: detail.output?.(output) ?? null }), interactionId);
    return output;
  }

  private failed(action: string, interactionId: string, error: unknown): void {
    this.session.error(error, true);
    try {
      this.publish('threw', () => ({ action, error: RuntimeErrorHelper.format(error) }), interactionId);
    } catch (observationError) {
      throw new AggregateError([error, observationError], 'Resource operation and failure observation both failed', { cause: error });
    }
  }
  private publish(phase: ResourceObservation['phase'], describe: () => unknown, interactionId?: string): void {
    this.session.publish(this.access, this.supplyId, phase, describe, interactionId);
  }
}
