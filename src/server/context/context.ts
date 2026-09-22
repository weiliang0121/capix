import { randomUUID } from 'node:crypto';

export type ContextState<O> = Readonly<{ status: 'running' } | { status: 'succeeded'; output: O } | { status: 'failed'; error: unknown }>;

/** Live invocation state. Values keep their identity; recording policy does not belong here. */
export class RuntimeContext<I = unknown, O = unknown> {
  readonly id = randomUUID();
  #state: ContextState<O> = Object.freeze({ status: 'running' });

  constructor(readonly input: I) {}

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
