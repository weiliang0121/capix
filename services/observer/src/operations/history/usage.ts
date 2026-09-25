import type { Message } from '@capix-observer/protocol';

/** Selection counts keyed by immutable message identity, independent of observation records. */
export class SelectionUsage {
  readonly #counts = new WeakMap<Readonly<Message>, number>();

  get(message: Readonly<Message>): number {
    return this.#counts.get(message) ?? 0;
  }

  add(messages: readonly Readonly<Message>[]): void {
    for (const message of new Set(messages)) this.#counts.set(message, this.get(message) + 1);
  }
}
