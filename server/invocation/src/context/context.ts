import type { InvocationFailure } from '../invocation/failure.js';
import { randomUUID } from 'node:crypto';
import type { InvocationResult } from '../invocation/result.js';
import type { CheckpointContinuationFact } from '../checkpoint/continuation.js';
import { stableValue, type Stable, type RuntimeErrorValue } from '@capix/contracts';
import { failureDiagnostic } from '../invocation/failure.js';

/** Per-invocation controls; application settings and resource selection belong to binding. */
export interface InvocationControls {
  readonly signal?: AbortSignal;
}

export type ContextState<Output> = Readonly<{ status: 'running' } | { status: 'succeeded'; output: Stable<Output> } | { status: 'failed'; error: unknown; diagnostic: Stable<RuntimeErrorValue>; failure?: InvocationFailure }>;

/** Live invocation state owns stable data facts; thrown errors retain their live identity. */
export class InvocationContext<Input = unknown, Output = unknown> {
  #id: string = randomUUID();
  get id(): string {
    return this.#id;
  }

  /** Identity-only baseline for a saved waiting relationship; no child progress is inferred. */
  installIdentity(id: string): void {
    this.requireRunning();
    if (this.#progress.round !== 0 || !id) throw new Error('Context identity can only be installed before progress');
    this.#id = id;
  }

  /** Final delivery baseline: preserves saved progress without inventing an execute result. */
  installDelivery(frame: { id: string; round: number; currentInput: Input | Stable<Input>; phase: 'execute' | 'receive' | 'handling' }, output: Output | Stable<Output>): void {
    this.installCheckpoint(frame);
    this.#progress = Object.freeze({ round: frame.round, input: this.currentInput, phase: frame.phase });
    this.complete(output);
  }

  /** A past declared failure remains diagnostic history, never a runnable exception. */
  installFailure(frame: { id: string; round: number; currentInput: Input | Stable<Input>; phase: 'execute' | 'receive' | 'handling' }, failure: InvocationFailure, diagnostic?: Stable<RuntimeErrorValue>): void {
    this.installCheckpoint(frame);
    this.#progress = Object.freeze({ round: frame.round, input: this.currentInput, phase: frame.phase });
    this.fail(failure.error, failure, diagnostic);
  }

  /** Construction-only installation; never exposed through ContextView. */
  installCheckpoint(frame: { id: string; round: number; currentInput: Input | Stable<Input>; continuation?: CheckpointContinuationFact }): void {
    this.requireRunning();
    if (this.#progress.round !== 0 || !frame.id || !Number.isInteger(frame.round) || frame.round < 1 || frame.round > 2) throw new Error('Invalid checkpoint context installation');
    const input = stableValue<Input>(frame.currentInput);
    this.#id = frame.id;
    this.#progress = Object.freeze({ round: frame.round, input, phase: 'execute' });
    this.#continuation = frame.continuation ? Object.freeze({ ...frame.continuation }) : undefined;
  }
  #state: ContextState<Output> = Object.freeze({ status: 'running' });
  #continuation?: CheckpointContinuationFact;

  #progress: Readonly<{ round: number; input: Stable<Input>; phase: 'execute' | 'receive' | 'handling'; result?: InvocationResult<Output> }>;
  readonly input: Stable<Input>;

  constructor(input: Input | Stable<Input>) {
    this.input = stableValue<Input>(input);
    this.#progress = Object.freeze({ round: 0, input: this.input, phase: 'execute' });
  }

  get progress() {
    return this.#progress;
  }
  get currentInput(): Stable<Input> {
    return this.#progress.input;
  }

  get continuation(): CheckpointContinuationFact | undefined {
    return this.#continuation;
  }

  /** Normal execution has one entry. The numeric progress field is retained for persisted facts. */
  start(): void {
    this.requireRunning();
    if (this.#progress.round !== 0) throw new Error('Invocation execution has already started');
    this.#progress = Object.freeze({ round: 1, input: this.input, phase: 'execute' });
  }

  returned(result: InvocationResult<Output>): void {
    this.requireRunning();
    const fixed = result.status === 'succeeded' ? { ...result, output: stableValue<Output>(result.output) } : { ...result, diagnostic: result.diagnostic ? stableValue<RuntimeErrorValue>(result.diagnostic) : failureDiagnostic(result.error) };
    this.requireRunning();
    this.#progress = Object.freeze({ ...this.#progress, result: Object.freeze(fixed) });
  }

  get state(): ContextState<Output> {
    return this.#state;
  }

  get status(): ContextState<Output>['status'] {
    return this.#state.status;
  }

  complete(output: Output | Stable<Output>): void {
    this.requireRunning();
    const fixed = stableValue<Output>(output);
    this.requireRunning();
    this.#state = Object.freeze({ status: 'succeeded', output: fixed });
  }

  fail(error: unknown, failure?: InvocationFailure, diagnostic?: Stable<RuntimeErrorValue>): void {
    this.requireRunning();
    const fixed = diagnostic ? stableValue<RuntimeErrorValue>(diagnostic) : failureDiagnostic(error);
    this.requireRunning();
    this.#state = Object.freeze({ status: 'failed', error, diagnostic: fixed, ...(failure ? { failure } : {}) });
  }

  requireRunning(): void {
    if (this.status !== 'running') throw new Error('Context has already ended');
  }
}
