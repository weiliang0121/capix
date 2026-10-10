import { isUndefined } from 'es-toolkit/predicate';
import { randomUUID } from 'node:crypto';
import type { TranscriptEvent, MemoryEvent } from '@capix/protocol';
import type { EventConsumer } from '../observation/binding.js';
import type { ResourceObservation } from '../observation/facts.js';
import { RuntimeErrorHelper } from '../errors/helper.js';

/** Internal call binding only. Business receives the resource endpoint, never this provenance port. */
export interface ResourceOwner {
  readonly contextId: string;
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
  validate(): void {
    try {
      if (this.parent) this.parent.validate();
      else this.owner?.validate();
      this.restriction?.();
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

  runSync<Output>(action: string, detail: ResourceInteractionDescription<Output>, execute: () => Output): Output {
    this.validate();
    const interactionId = randomUUID();
    this.publish('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    let output: Output;
    try {
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
