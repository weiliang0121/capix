import type { ChangeCapture } from './capture.js';

/** Pending facts from one or more sources. Not a history, transport cursor or delivery acknowledgement. */
export class ChangeObserver<E> implements ChangeCapture<E> {
  #pending: E[] = [];
  readonly #waiters = new Set<() => void>();

  /** Wake a consumer through a promise; capture never executes consumer work inline. */
  wait(signal: AbortSignal): Promise<void> {
    if (this.#pending.length || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const ready = () => {
        this.#waiters.delete(ready);
        signal.removeEventListener('abort', ready);
        resolve();
      };
      this.#waiters.add(ready);
      signal.addEventListener('abort', ready, { once: true });
    });
  }

  readonly capture = (event: E): void => {
    this.#pending.push(event);
    for (const ready of this.#waiters) ready();
  };

  get size(): number {
    return this.#pending.length;
  }

  /** Transfer pending facts to the caller; subsequent captures belong to the next batch. */
  take(): readonly E[] {
    const batch = Object.freeze(this.#pending);
    this.#pending = [];
    return batch;
  }
}
