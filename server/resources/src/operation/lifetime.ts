import { ResourceAccessClosed, ResourcePortError } from '../errors.js';

/** Cleanup belongs to one resource operation, independently of the supplied entity. */
export class ResourceOperationLifetime {
  readonly #cleanups = new Set<(reason: unknown) => void>();
  #closed?: { readonly reason: unknown };
  #interruption?: { readonly reason: unknown };
  #failure?: ResourcePortError;
  readonly #cancel: () => void;

  constructor(private readonly signal: AbortSignal | undefined) {
    this.#cancel = () => this.close(signal?.reason);
    signal?.addEventListener('abort', this.#cancel, { once: true });
    if (signal?.aborted) this.#cancel();
  }

  get interruption(): { readonly reason: unknown } | undefined {
    return this.#interruption;
  }

  get failure(): ResourcePortError | undefined {
    return this.#failure;
  }

  assertOpen(): void {
    if (this.#closed) throw new ResourceAccessClosed('Resource operation output is closed');
  }

  onClose(cleanup: (reason: unknown) => void): () => void {
    if (typeof cleanup !== 'function') {
      const failure = new ResourcePortError('Resource operation cleanup must be a function');
      this.record(failure);
      throw failure;
    }
    if (this.#closed) {
      const failure = this.invoke(cleanup, this.#closed.reason);
      if (failure) throw failure;
    } else {
      this.#cleanups.add(cleanup);
    }
    return () => {
      this.#cleanups.delete(cleanup);
    };
  }

  /** An access window or local cancellation ends consumption, never the external sender. */
  close(reason: unknown): void {
    if (this.#closed) return;
    this.#interruption = { reason };
    this.seal(reason);
  }

  /** Ordinary method completion releases consumers before result reception begins. */
  finish(): void {
    this.seal(new ResourceAccessClosed('Resource operation has completed'));
  }

  private seal(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = { reason };
    this.signal?.removeEventListener('abort', this.#cancel);
    // Remove each callback before invoking it. Close/detach/late registration can reenter.
    for (const cleanup of this.#cleanups) {
      this.#cleanups.delete(cleanup);
      this.invoke(cleanup, reason);
    }
  }

  private invoke(cleanup: (reason: unknown) => void, reason: unknown): ResourcePortError | undefined {
    try {
      const returned: unknown = cleanup(reason);
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError('Resource operation cleanup must return undefined synchronously');
      }
      return undefined;
    } catch (cause) {
      const failure = new ResourcePortError('Resource operation cleanup failed', { cause });
      this.record(failure);
      return failure;
    }
  }

  private record(failure: ResourcePortError): void {
    this.#failure = this.#failure ? new ResourcePortError('Multiple resource operation cleanups failed', { cause: new AggregateError([this.#failure, failure]) }) : failure;
  }
}
