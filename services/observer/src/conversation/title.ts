import type { Message } from '@weiliang0121/capix-protocol';

/** A stable first-input label; naming a conversation never invokes a model. */
export function conversationTitle(messages: readonly Pick<Message, 'role' | 'content'>[]): string {
  const first = messages.find((message) => message.role === 'user');
  return first ? Array.from(first.content.replace(/\s+/g, ' ').trim()).slice(0, 48).join('') || '新对话' : '新对话';
}
