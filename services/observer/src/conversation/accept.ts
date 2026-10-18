import { RuntimeError, isObject, isNonEmptyArray, isNonBlankString } from '@capix/server-runtime';
import { type Transcript } from '@capix/server-runtime/content';

import type { Message, FileTask } from '@capix/protocol';
import { isRelativeFilePath } from '../files/index.js';

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
    return messages.map((_, offset) => ({ index: start + offset, message: transcript.get(start + offset)! }));
  }).message;
}

export function acceptMessages<Receipt extends { readonly message: Readonly<Message> }>(value: unknown, append: (messages: readonly Message[]) => readonly Receipt[]): Receipt {
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
  return append(messages).at(-1)!;
}

export interface AcceptedConversationInput {
  readonly message: Readonly<Message>;
  readonly messageIndex: number;
  readonly fileTask?: FileTask;
}

/** Validate optional capability instructions before appending any formal message. */
export function acceptConversationRequest(value: unknown, append: (messages: readonly Message[]) => readonly { readonly index: number; readonly message: Readonly<Message> }[], filesEnabled: boolean): AcceptedConversationInput {
  const fileTask = acceptFileTask(isObject(value) ? value.fileTask : undefined, filesEnabled);
  const accepted = acceptMessages(value, append);
  return Object.freeze({ message: accepted.message, messageIndex: accepted.index, ...(fileTask ? { fileTask } : {}) });
}

function acceptFileTask(value: unknown, enabled: boolean): FileTask | undefined {
  if (value === undefined) return undefined;
  if (!enabled) throw new ConversationInputError('当前服务未启用文件处理。');
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'sourcePath' && key !== 'output') || (value.sourcePath !== undefined && !isRelativeFilePath(value.sourcePath))) throw new ConversationInputError('文件任务需要合法的工作目录相对路径。');
  if (value.output !== undefined && (!isObject(value.output) || Object.keys(value.output).some((key) => key !== 'path') || !isRelativeFilePath(value.output.path))) throw new ConversationInputError('输出文件需要合法的工作目录相对路径。');
  const output = value.output as { path: string } | undefined;
  if (value.sourcePath === undefined && !output) throw new ConversationInputError('文件任务至少需要源文件或输出文件。');
  if (output?.path === value.sourcePath) throw new ConversationInputError('输出必须是不同于源文件的新文件。');
  if (value.sourcePath === undefined) return Object.freeze({ output: Object.freeze({ path: output!.path }) });
  return Object.freeze({ sourcePath: value.sourcePath as string, ...(output ? { output: Object.freeze({ path: output.path }) } : {}) });
}
