import type { Message } from '../../shared/types.js';

/** Temporary editor data. Server-side Transcript owns formal message acceptance. */
export class MessageDraft {
  readonly #messages: Message[];

  constructor(value: unknown = []) {
    this.#messages = MessageDraft.read(value);
  }

  append(...messages: Message[]): void {
    this.#messages.push(...MessageDraft.read(messages));
  }

  snapshot(): Message[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  private static read(value: unknown): Message[] {
    if (!Array.isArray(value)) throw new Error('消息集合必须是数组。');
    return Array.from(value, (message: unknown) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error('消息必须是包含 role 和 content 的对象。');
      const { role, content } = message as Record<string, unknown>;
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) throw new Error('消息需要 user/assistant 角色和非空 content。');
      return { role, content };
    });
  }
}
