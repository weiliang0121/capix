import type { ProgressReceiver } from '@capix/contracts';
export type { ProgressReceiver } from '@capix/contracts';

export interface ProgressFailure {
  readonly error: unknown;
}

/** A local delivery boundary: a faulty receiver is disabled without changing its producer. */
export class ProgressChannel<Fact> {
  #failure?: ProgressFailure;

  constructor(private readonly receiver: ProgressReceiver<Fact>) {}

  get failure(): ProgressFailure | undefined {
    return this.#failure;
  }

  publish(fact: Readonly<Fact>): void {
    if (this.#failure) return;
    try {
      const returned: unknown = this.receiver.receive(fact);
      if (returned !== undefined) {
        // An accidentally async callback must not leak an unhandled rejection.
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError('Progress receivers must return undefined synchronously');
      }
    } catch (error) {
      this.#failure = Object.freeze({ error });
      try {
        const reported: unknown = this.receiver.failed?.(error);
        if (reported !== undefined) void Promise.resolve(reported).catch(() => undefined);
      } catch {
        // Reporting a receiver failure is also outside the producer's lifecycle.
      }
    }
  }
}
