import { randomUUID } from 'node:crypto';
import type { OperationOptions, OperationOutcome, OperationResult } from '@capix/contracts';
import { receiveOperation } from './operation/receive.js';
import type { ResourceOperation } from './methods.js';
import type { ResourceObservation } from './facts.js';
import { ResourcePortError, type ResourceOwner, type ResourceWindow } from './ports.js';
import type { ResourceSupplyEntry } from './supply.js';
import { ResourceEndpointActivity, type ResourceOperationSource } from './endpoint.js';
import { isResourceAccessFailure } from './failure.js';
import { ResourceOperationLifetime } from './operation/lifetime.js';

export type { ResourceOwner, ResourceFailurePolicy } from './ports.js';

export interface ResourceOperationDescription<Output> {
  readonly input?: () => unknown;
  readonly output?: (result: Output) => unknown;
}

/** One executor shared by the endpoints in a single access window. Operation state stays local. */
export class ResourceActivity {
  #sequence = 0;
  readonly #operations = new Set<ResourceOperationLifetime>();
  constructor(
    private readonly window: ResourceWindow,
    readonly owner?: ResourceOwner,
  ) {}

  forResource(entry: ResourceSupplyEntry): ResourceEndpointActivity {
    return new ResourceEndpointActivity(this, Object.freeze({ offerId: entry.offer.id, access: entry.offer.name, supplyId: entry.supplyId }));
  }

  validate(): void {
    try {
      this.window.assertOpen();
    } catch (error) {
      this.reject(error);
    }
  }

  error(error: unknown, allowException = false): void {
    try {
      this.owner?.error?.(error, allowException);
    } catch (report) {
      if (report === error) throw error;
      throw new AggregateError([error, report], 'Resource failure and its owner notification both failed', { cause: error });
    }
  }

  reject(error: unknown, allowException = false): never {
    this.error(error, allowException);
    throw error;
  }

  /** Preserve an already classified host failure; classify only otherwise ordinary port errors. */
  rejectPort(error: unknown, message: string): never {
    if (this.isProtected(error)) this.reject(error);
    this.reject(new ResourcePortError(message, { cause: error }));
  }

  publish(source: ResourceOperationSource, phase: ResourceObservation['phase'], describe: () => unknown, operationId?: string): void {
    const owner = this.owner;
    if (!owner?.observation) return;
    try {
      const fact: ResourceObservation = Object.freeze({ contextId: owner.contextId, ...source, sequence: owner.nextSequence ? owner.nextSequence() : ++this.#sequence, occurredAt: new Date().toISOString(), phase, ...(operationId ? { interactionId: operationId } : {}), describe });
      const error = owner.observation.publish(fact);
      if (error !== undefined) throw error;
    } catch (error) {
      this.reject(error);
    }
  }

  describe(error: unknown): unknown {
    return this.owner?.failures.describe(error) ?? { message: 'Resource operation failed' };
  }

  /** Revoke local consumers, exhausting cleanup even when one adapter fails. */
  close(reason: unknown): void {
    const operations = [...this.#operations];
    this.#operations.clear();
    const failures: unknown[] = [];
    for (const operation of operations) {
      operation.close(reason);
      if (operation.failure) failures.push(operation.failure);
    }
    if (failures.length) this.reject(failures.length === 1 ? failures[0] : new AggregateError(failures, 'Resource operation cleanup failures'));
  }

  async operate<Output, Delta = never, const Options extends OperationOptions<Output, unknown, unknown, Delta> = {}>(source: ResourceOperationSource, action: string, detail: ResourceOperationDescription<Output>, execute: (operation: ResourceOperation<Delta>) => Output | PromiseLike<Output>, options?: Options): Promise<OperationResult<Output, Options>> {
    this.validate();
    let reception: Options | undefined;
    let consume: ((delta: Delta) => void) | undefined;
    try {
      const receiver = options?.result;
      if (options?.delta !== undefined && typeof options.delta !== 'function') throw new TypeError('Delta receiver must be a function');
      if (receiver?.succeeded !== undefined && typeof receiver.succeeded !== 'function') throw new TypeError('Success receiver must be a function');
      if (receiver?.failed !== undefined && typeof receiver.failed !== 'function') throw new TypeError('Failure receiver must be a function');
      reception = options ? { ...options, result: { succeeded: receiver?.succeeded?.bind(receiver), failed: receiver?.failed?.bind(receiver) } } : options;
      consume = options?.delta?.bind(options);
    } catch (error) {
      this.reject(error);
    }
    const operationId = randomUUID();
    this.publish(source, 'started', () => ({ action, input: detail.input?.() ?? null }), operationId);
    this.validate();
    const lifetime = new ResourceOperationLifetime(this.window.signal);
    this.#operations.add(lifetime);
    const operation: ResourceOperation<Delta> = Object.freeze({
      signal: this.window.signal,
      onClose: (cleanup: (reason: unknown) => void) => {
        try {
          return lifetime.onClose(cleanup);
        } catch (error) {
          this.reject(error);
        }
      },
      emit: (delta: Delta) => {
        try {
          lifetime.assertOpen();
        } catch (error) {
          this.reject(error);
        }
        this.validate();
        if (!consume) return;
        try {
          const returned: unknown = consume(delta);
          void Promise.resolve(returned).catch(() => {
            consume = undefined;
          });
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
      consume = undefined;
      lifetime.finish();
      this.#operations.delete(lifetime);
    }
    try {
      this.returned(source, action, detail, operationId, outcome);
    } catch (error) {
      if (lifetime.failure && error !== lifetime.failure) this.reject(new AggregateError([error, lifetime.failure], 'Resource observation and cleanup both failed', { cause: error }));
      throw error;
    }
    if (lifetime.failure) outcome = { status: 'failed', failure: outcome.status === 'failed' && outcome.failure !== lifetime.failure ? new AggregateError([outcome.failure, lifetime.failure], 'Resource operation and cleanup both failed', { cause: outcome.failure }) : lifetime.failure };
    this.checkReception(outcome);
    if (lifetime.interruption) this.reject(outcome.status === 'failed' && outcome.failure !== lifetime.interruption.reason ? new AggregateError([outcome.failure, lifetime.interruption.reason], 'Resource operation failed after local consumption ended', { cause: outcome.failure }) : lifetime.interruption.reason);
    if (outcome.status === 'failed' && (this.isProtected(outcome.failure) || !reception?.result?.failed)) this.reject(outcome.failure, true);
    let received: OperationResult<Output, Options>;
    try {
      received = await receiveOperation<Output, unknown, Options>(outcome, reception);
    } catch (error) {
      this.reject(error, true);
    }
    this.checkReception(outcome);
    return received;
  }

  runSync<Output>(source: ResourceOperationSource, action: string, detail: ResourceOperationDescription<Output>, execute: () => Output): Output {
    this.validate();
    const operationId = randomUUID();
    this.publish(source, 'started', () => ({ action, input: detail.input?.() ?? null }), operationId);
    this.validate();
    let outcome: OperationOutcome<Output>;
    try {
      outcome = { status: 'succeeded', value: execute() };
    } catch (failure) {
      outcome = { status: 'failed', failure };
    }
    this.returned(source, action, detail, operationId, outcome);
    this.checkReception(outcome);
    if (outcome.status === 'failed') this.reject(outcome.failure, true);
    return outcome.value;
  }

  private returned<Output>(source: ResourceOperationSource, action: string, detail: ResourceOperationDescription<Output>, operationId: string, outcome: OperationOutcome<Output>): void {
    try {
      if (outcome.status === 'succeeded') this.publish(source, 'returned', () => ({ action, output: detail.output?.(outcome.value) ?? null }), operationId);
      else this.publish(source, 'threw', () => ({ action, error: this.describe(outcome.failure) }), operationId);
    } catch (observation) {
      if (outcome.status === 'failed' && observation !== outcome.failure) this.reject(new AggregateError([outcome.failure, observation], 'Resource operation and failure observation both failed', { cause: outcome.failure }));
      throw observation;
    }
  }

  private checkReception(outcome: OperationOutcome<unknown>): void {
    try {
      this.window.assertOpen();
    } catch (windowFailure) {
      this.reject(outcome.status === 'failed' ? this.combineWindowFailure(outcome.failure, windowFailure) : windowFailure);
    }
  }

  private combineWindowFailure(failure: unknown, windowFailure: unknown): unknown {
    const signal = this.window.signal;
    if (windowFailure === failure || (signal && this.classify(failure, () => this.owner?.failures.isCancellation(failure, signal) ?? false) && this.classify(windowFailure, () => this.owner?.failures.isCancellation(windowFailure, signal) ?? false))) return failure;
    return new AggregateError([failure, windowFailure], 'Resource operation failed after its access window became unavailable', { cause: failure });
  }

  private isProtected(error: unknown): boolean {
    return isResourceAccessFailure(error) || this.classify(error, () => this.owner?.failures.isProtected(error) ?? false);
  }

  private classify(error: unknown, classify: () => boolean): boolean {
    try {
      const result: unknown = classify();
      if (typeof result !== 'boolean') {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError('Resource failure classification must return a boolean');
      }
      return result;
    } catch (failure) {
      this.reject(new AggregateError([error, failure], 'Resource operation and failure classification both failed', { cause: error }));
    }
  }
}
