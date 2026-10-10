import { RuntimeError, isObject, isNonEmptyArray, isNonBlankString } from '@capix/server-runtime';
import { type Transcript } from '@capix/server-runtime/content';

import type { Message } from '@capix/protocol';

export class ConversationInputError extends RuntimeError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
  }
}

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
    throw new ConversationInputError('需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  const lastMessage = value.messages.at(-1);
  if (!isObject(lastMessage) || lastMessage.role !== 'user') {
    throw new ConversationInputError('需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  // Reject malformed input before calling the entity; later publication errors are not input errors.
  const messages = value.messages.map((message) => {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant') || !isNonBlankString(message.content)) throw new ConversationInputError('消息必须包含 user/assistant 角色和非空 content。');
    return { role: message.role, content: message.content } satisfies Message;
  });
  return append(messages).at(-1)!.message;
}
