import { RuntimeError } from '../errors/error.js';
import type { Transcript } from '../transcript/transcript.js';
import type { Message } from '../../shared/transcript/message.js';
import { isObject } from '../value/object.js';

/** Accept a batch into an existing Transcript; its final user message triggers this call. */
export function acceptExecutionInput(transcript: Transcript, value: unknown): Readonly<Message> {
  if (!isObject(value) || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 501 || !isObject(value.messages.at(-1)) || value.messages.at(-1).role !== 'user') {
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
