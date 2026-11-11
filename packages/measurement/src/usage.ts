import type { Message } from '@weiliang0121/capix-transcript';

/** Material-use counts keyed by immutable message identity, scoped to this instance and independent of records. */
export class MessageUsage {
  readonly #counts = new WeakMap<Readonly<Message>, number>();

  get(message: Readonly<Message>): number {
    return this.#counts.get(message) ?? 0;
  }

  add(messages: readonly Readonly<Message>[]): void {
    for (const message of new Set(messages)) this.#counts.set(message, this.get(message) + 1);
  }
}
