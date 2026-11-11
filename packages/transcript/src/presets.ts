import type { Message } from './types.js';

/** Absolute positions from a single transcript; gaps may be introduced by a view. */
export interface IndexedMessage {
  readonly index: number;
  readonly message: Readonly<Message>;
}

/** A positional grouping, not a claim about submissions, turns or causality. */
export type AdjacentMessageGroup = readonly [IndexedMessage] | readonly [IndexedMessage, IndexedMessage];

/**
 * Pair an immediately adjacent user and assistant; retain every other message as a singleton.
 * Input must retain ascending original indexes. Never sort, bridge a gap or change membership.
 * Only grouping containers are created: accepted message objects keep their identity.
 */
export function groupAdjacentPairs(messages: readonly IndexedMessage[]): readonly AdjacentMessageGroup[] {
  if (!Array.isArray(messages)) throw new TypeError('Message grouping requires indexed messages');
  let previous = -1;
  const entries = Array.from(messages, (entry) => {
    const index = entry?.index;
    const message = entry?.message;
    if (!Number.isSafeInteger(index) || index <= previous) throw new RangeError('Message grouping requires strictly increasing nonnegative indexes');
    if (message?.role !== 'user' && message?.role !== 'assistant') throw new TypeError('Message grouping requires user or assistant messages');
    previous = index;
    return Object.freeze({ index, message });
  });
  const groups: AdjacentMessageGroup[] = [];
  for (let position = 0; position < entries.length; position++) {
    const current = entries[position]!;
    const next = entries[position + 1];
    if (current.message.role === 'user' && next?.message.role === 'assistant' && next.index === current.index + 1) {
      groups.push(Object.freeze([current, next]));
      position++;
    } else groups.push(Object.freeze([current]));
  }
  return Object.freeze(groups);
}
