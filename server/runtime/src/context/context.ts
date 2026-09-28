import { randomUUID } from 'node:crypto';
import { Continuation, type InvocationResult } from '../invocation/result.js';

export type ContextState<O> = Readonly<{ status: 'running' } | { status: 'succeeded'; output: O } | { status: 'failed'; error: unknown }>;

/** Live invocation state. Values keep their identity; recording policy does not belong here. */
export class InvocationContext<I = unknown, O = unknown> {
  readonly id = randomUUID();
  #state: ContextState<O> = Object.freeze({ status: 'running' });

  #progress: Readonly<{ round: number; input: I; phase: 'execute' | 'receive'; result?: InvocationResult<O> }>;

  constructor(readonly input: I) {
    this.#progress = Object.freeze({ round: 0, input, phase: 'execute' });
  }

  get progress() {
    return this.#progress;
  }
  get currentInput(): I {
    return this.#progress.input;
  }

  startRound(round: number, input: I): void {
    this.requireRunning();
    if (round !== this.#progress.round + 1) throw new Error('Invocation rounds must advance in order');
    this.#progress = Object.freeze({ round, input, phase: 'execute' });
  }

  receiving(result: InvocationResult<O>): void {
    this.requireRunning();
    this.#progress = Object.freeze({ ...this.#progress, phase: 'receive', result: Object.freeze(result) });
  }

  continueWith(input: I, reason: string): Continuation<I> {
    this.requireRunning();
    return new Continuation(input, reason);
  }

  get state(): ContextState<O> {
    return this.#state;
  }

  get status(): ContextState<O>['status'] {
    return this.#state.status;
  }

  complete(output: O): void {
    this.requireRunning();
    this.#state = Object.freeze({ status: 'succeeded', output });
  }

  fail(error: unknown): void {
    this.requireRunning();
    this.#state = Object.freeze({ status: 'failed', error });
  }

  requireRunning(): void {
    if (this.status !== 'running') throw new Error('Context has already ended');
  }
}
