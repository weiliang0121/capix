import { randomUUID } from 'node:crypto';
import type { ResourceFact } from '@capix-observer/protocol';
import type { ChangeSource } from '../records/source.js';
import type { Recorder } from '../records/recorder.js';
import { ResourceRecord } from '../records/resource/record.js';
import { writeRecord } from '../records/error.js';
import { RuntimeErrorHelper } from '../errors/helper.js';

/** Internal call binding only. Business receives the resource endpoint, never this provenance port. */
export interface ResourceOwner {
  readonly contextId: string;
  readonly source: () => ChangeSource | undefined;
  readonly validate: () => void;
  readonly error?: (error: unknown, allowException?: boolean) => void;
  readonly recording?: { readonly recorder: Recorder; readonly parentId: () => string };
}
export interface ResourceOperation<T> {
  readonly input?: () => unknown;
  readonly output?: (result: T) => unknown;
}

/** Per-call local order and record owner; sharing a supply never shares this session. */
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
  record(access: string, supplyId: string, phase: ResourceFact['phase'], describe: () => unknown, interactionId?: string): void {
    if (this.parent) return this.parent.record(access, supplyId, phase, describe, interactionId);
    const recording = this.owner?.recording;
    if (!recording) return;
    try {
      writeRecord(() => recording.recorder.add(new ResourceRecord({ parentId: recording.parentId(), access, supplyId, sequence: ++this.#sequence, occurredAt: recording.recorder.clock.now(), phase, ...(interactionId ? { interactionId } : {}) }, describe())));
    } catch (error) {
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
  source(): ChangeSource | undefined {
    return this.session.owner?.source();
  }
  bound(): void {
    this.record('bound', () => null);
  }
  available(describe: () => unknown): void {
    this.record('available', describe);
  }
  unavailable(error: unknown): void {
    this.session.error(error);
    this.record('unavailable', () => ({ error: RuntimeErrorHelper.format(error) }));
  }

  runSync<T>(action: string, detail: ResourceOperation<T>, execute: () => T): T {
    this.validate();
    const interactionId = randomUUID();
    this.record('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    let output: T;
    try {
      output = execute();
    } catch (error) {
      this.failed(action, interactionId, error);
      throw error;
    }
    // Registration failure here must not be mistaken for an operation failure or retry it.
    this.record('returned', () => ({ action, output: detail.output?.(output) ?? null }), interactionId);
    return output;
  }

  async runAsync<T>(action: string, detail: ResourceOperation<T>, execute: () => Promise<T>): Promise<T> {
    this.validate();
    const interactionId = randomUUID();
    this.record('started', () => ({ action, input: detail.input?.() ?? null }), interactionId);
    let output: T;
    try {
      output = await execute();
    } catch (error) {
      this.failed(action, interactionId, error);
      throw error;
    }
    this.record('returned', () => ({ action, output: detail.output?.(output) ?? null }), interactionId);
    return output;
  }

  private failed(action: string, interactionId: string, error: unknown): void {
    this.session.error(error, true);
    try {
      this.record('threw', () => ({ action, error: RuntimeErrorHelper.format(error) }), interactionId);
    } catch (recordingError) {
      throw new AggregateError([error, recordingError], 'Resource operation and failure recording both failed', { cause: error });
    }
  }
  private record(phase: ResourceFact['phase'], describe: () => unknown, interactionId?: string): void {
    this.session.record(this.access, this.supplyId, phase, describe, interactionId);
  }
}
