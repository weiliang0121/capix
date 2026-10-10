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
  readonly id = randomUUID();
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
