import { InvocationCancelled, isInvocationCancelled } from '@capix/invocation';

/** One entry's control signal. The original host options and signal are never rewritten. */
export class RunnerCancellation {
  readonly #controller = new AbortController();
  #origin?: 'runner' | 'external';
  readonly #externalAborted = () => {
    if (this.#controller.signal.aborted) return;
    this.#origin = 'external';
    this.#controller.abort(this.external?.reason);
  };

  constructor(private readonly external?: AbortSignal) {
    if (external) {
      if (!(external instanceof AbortSignal)) throw new TypeError('Runner signal must be an AbortSignal');
      if (external.aborted) this.#externalAborted();
      else external.addEventListener('abort', this.#externalAborted, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  cancel(reason?: unknown): boolean {
    // External abort listeners can reenter before our own listener is reached.
    if (!this.signal.aborted && this.external?.aborted) this.#externalAborted();
    if (this.signal.aborted) return false;
    this.#origin = 'runner';
    this.#controller.abort(reason);
    return true;
  }

  /** Preserve the external caller's exact cancellation identity at the host boundary only. */
  deliveryError(error: unknown): unknown {
    if (this.#origin === 'external' && this.external && isInvocationCancelled(error, this.signal)) return new InvocationCancelled(this.external, { cause: error });
    return error;
  }

  dispose(): void {
    this.external?.removeEventListener('abort', this.#externalAborted);
  }
}
