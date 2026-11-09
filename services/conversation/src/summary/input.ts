import type { Message } from '@weiliang0121/capix-protocol';
import { requireText } from '../text.js';

export interface HistoryInput {
  readonly query: string;
  readonly history: readonly Readonly<Message>[];
}

export interface RevisionInput {
  readonly query: string;
  readonly answer: { readonly index: number; readonly content: string };
}

/** The Scene supplies a prefix ending at its accepted user message, never an ambient current view. */
export function prepareHistoryInput(prefix: readonly Readonly<Message>[]): HistoryInput {
  if (!Array.isArray(prefix) || !prefix.length) throw new TypeError('History processing requires an accepted input prefix');
  const messages = Array.from(prefix, (message) => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') throw new TypeError('History processing requires formal text messages');
    return Object.freeze({ role: message.role, content: message.content });
  });
  const current = messages.at(-1)!;
  if (current.role !== 'user') throw new TypeError('History processing requires the current user message at the end');
  return Object.freeze({ query: requireText(current.content, 'Current input'), history: Object.freeze(messages.slice(0, -1)) });
}

/** A revision receives the exact latest accepted assistant text, not a model-generated quotation. */
export function revisionInput(input: HistoryInput): RevisionInput | undefined {
  const index = input.history.findLastIndex((message) => message.role === 'assistant');
  if (index < 0) return undefined;
  return Object.freeze({ query: input.query, answer: Object.freeze({ index, content: input.history[index]!.content }) });
}
