import { RuntimeError, isObject, isNonEmptyArray } from '@capix/server-runtime';
import { type Transcript } from '@capix/server-runtime/content';

import type { Message } from '@capix/protocol';

/** Accept a batch into an existing Transcript; its final user message triggers this call. */
export function acceptConversationInput(transcript: Transcript, value: unknown): Readonly<Message> {
  return acceptMessages(value, (messages) => {
    const start = transcript.length;
    transcript.append(...messages);
    return messages.map((_, offset) => ({ message: transcript.get(start + offset)! }));
  });
}

export function acceptMessages(value: unknown, append: (messages: readonly Message[]) => readonly { message: Readonly<Message> }[]): Readonly<Message> {
  if (!isObject(value) || !isNonEmptyArray(value.messages) || value.messages.length > 501) {
    throw new RuntimeError('INVALID_INPUT', '需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  const lastMessage = value.messages.at(-1);
  if (!isObject(lastMessage) || lastMessage.role !== 'user') {
    throw new RuntimeError('INVALID_INPUT', '需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  try {
    return append(value.messages as Message[]).at(-1)!.message;
  } catch (error) {
    if (error instanceof TypeError) throw new RuntimeError('INVALID_INPUT', error.message);
    throw error;
  }
}
