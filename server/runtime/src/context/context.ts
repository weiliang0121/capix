import type { InvocationFailure } from '../invocation/failure.js';
import { randomUUID } from 'node:crypto';
import { Continuation, type InvocationResult } from '../invocation/result.js';

/** Per-invocation controls; application settings and resource selection belong to binding. */
export interface InvocationControls {
  readonly signal?: AbortSignal;
}

export type ContextState<Output> = Readonly<{ status: 'running' } | { status: 'succeeded'; output: Output } | { status: 'failed'; error: unknown; failure?: InvocationFailure }>;

/** Live invocation state. Values keep their identity; recording policy does not belong here. */
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
  installDelivery(frame: { id: string; round: number; currentInput: Input; phase: 'execute' | 'receive' | 'handling' }, output: Output): void {
    this.installCheckpoint(frame);
    this.#progress = Object.freeze({ round: frame.round, input: frame.currentInput, phase: frame.phase });
    this.complete(output);
  }

  /** A past declared failure remains diagnostic history, never a runnable exception. */
  installFailure(frame: { id: string; round: number; currentInput: Input; phase: 'execute' | 'receive' | 'handling' }, failure: InvocationFailure): void {
    this.installCheckpoint(frame);
    this.#progress = Object.freeze({ round: frame.round, input: frame.currentInput, phase: frame.phase });
    this.fail(failure.error, failure);
  }

  /** Construction-only installation; never exposed through ContextView. */
  installCheckpoint(frame: { id: string; round: number; currentInput: Input }): void {
    this.requireRunning();
    if (this.#progress.round !== 0 || !frame.id || !Number.isInteger(frame.round) || frame.round < 1 || frame.round > 2) throw new Error('Invalid checkpoint context installation');
    this.#id = frame.id;
    this.#progress = Object.freeze({ round: frame.round, input: frame.currentInput, phase: 'execute' });
  }
  #state: ContextState<Output> = Object.freeze({ status: 'running' });

  #progress: Readonly<{ round: number; input: Input; phase: 'execute' | 'receive' | 'handling'; result?: InvocationResult<Output> }>;

  constructor(readonly input: Input) {
    this.#progress = Object.freeze({ round: 0, input, phase: 'execute' });
  }

  get progress() {
    return this.#progress;
  }
  get currentInput(): Input {
    return this.#progress.input;
  }

  startRound(round: number, input: Input): void {
    this.requireRunning();
    if (round !== this.#progress.round + 1) throw new Error('Invocation rounds must advance in order');
    this.#progress = Object.freeze({ round, input, phase: 'execute' });
  }

  receiving(result: InvocationResult<Output>): void {
    this.requireRunning();
    this.#progress = Object.freeze({ ...this.#progress, phase: 'receive', result: Object.freeze(result) });
  }

  handling(): void {
    this.requireRunning();
    this.#progress = Object.freeze({ ...this.#progress, phase: 'handling' });
  }

  continueWith(input: Input, reason: string): Continuation<Input> {
    this.requireRunning();
    return new Continuation(input, reason);
  }

  get state(): ContextState<Output> {
    return this.#state;
  }

  get status(): ContextState<Output>['status'] {
    return this.#state.status;
  }

  complete(output: Output): void {
    this.requireRunning();
    this.#state = Object.freeze({ status: 'succeeded', output });
  }

  fail(error: unknown, failure?: InvocationFailure): void {
    this.requireRunning();
    this.#state = Object.freeze({ status: 'failed', error, ...(failure ? { failure } : {}) });
  }

  requireRunning(): void {
    if (this.status !== 'running') throw new Error('Context has already ended');
  }
}
