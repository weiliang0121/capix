import type { ConversationRequest } from '@capix/protocol';
import { isPlainObject } from 'es-toolkit/predicate';

/** Local acceptance fixes new input only; server-owned history is captured when it runs. */
export function acceptConversationRequest(input: ConversationRequest): { input: ConversationRequest; bytes: number } {
  if (!isPlainObject(input) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 501) throw new Error('提交需要 1–501 条消息。');
  const messages = input.messages.map((message) => {
    if (!isPlainObject(message) || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !message.content.trim()) throw new Error('每条消息需要 user / assistant 角色与非空正文。');
    return Object.freeze({ role: message.role, content: message.content });
  });
  if (messages.at(-1)?.role !== 'user') throw new Error('最后一条消息必须是用户输入。');
  if (input.contextBudget !== undefined && (!Number.isSafeInteger(input.contextBudget) || input.contextBudget < 256 || input.contextBudget > 1_000_000)) throw new Error('容量预算需要是 256–1000000 的整数。');
  Object.freeze(messages);
  const accepted = Object.freeze({ messages, ...(input.contextBudget === undefined ? {} : { contextBudget: input.contextBudget }) });
  const bytes = new TextEncoder().encode(JSON.stringify(accepted)).byteLength;
  // Leave room for the submission envelope under the service's 4 MiB request limit.
  if (bytes > 4 * 1024 * 1024 - 256) throw new Error('提交内容超过 4 MiB 请求限制。');
  return { input: accepted, bytes };
}
