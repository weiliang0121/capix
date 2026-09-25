import { RuntimeError, type Transcript, isObject, isNonEmptyArray } from '@capix-observer/runtime';

import type { Message } from '@capix-observer/protocol';

/** Accept a batch into an existing Transcript; its final user message triggers this call. */
export function acceptExecutionInput(transcript: Transcript, value: unknown): Readonly<Message> {
  if (!isObject(value) || !isNonEmptyArray(value.messages) || value.messages.length > 501) {
    throw new RuntimeError('INVALID_INPUT', '需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  const lastMessage = value.messages.at(-1);
  if (!isObject(lastMessage) || lastMessage.role !== 'user') {
    throw new RuntimeError('INVALID_INPUT', '需要 1–501 条新消息，最后一条必须是 user 消息。');
  }
  try {
    transcript.append(...(value.messages as Message[]));
    return transcript.get(transcript.length - 1)!;
  } catch (error) {
    if (error instanceof TypeError) throw new RuntimeError('INVALID_INPUT', error.message);
    throw error;
  }
}
