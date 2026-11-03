import { randomUUID } from 'node:crypto';
import type { ModelProvider, ModelReply } from '@capix/model-provider';
import { z } from 'zod';

const material = z.object({ query: z.object({ content: z.string() }), materials: z.object({ entries: z.array(z.object({ source: z.enum(['messages', 'memories']), value: z.object({ content: z.string() }) })) }) });
const extraction = z.object({ messages: z.array(z.object({ index: z.number().int().nonnegative(), message: z.object({ role: z.enum(['user', 'assistant']), content: z.string() }) })), memories: z.array(z.object({ id: z.string(), topic: z.string(), content: z.string() })) });

/** A deterministic teaching fixture. It stores the last input, not an inferred preference. */
export function createDemoModel(): ModelProvider {
  const reply = (text: string): ModelReply => ({ id: randomUUID(), model: 'offline-demo', text, finishReason: 'stop', usage: null });
  return {
    async complete(request, controls = {}) {
      controls.signal?.throwIfAborted();
      const encoded = request.messages.find((message) => message.role === 'user')?.content;
      if (encoded === undefined) throw new Error('Demo requires the service material payload');
      const payload: unknown = JSON.parse(encoded);
      if (request.responseFormat === 'text') {
        const input = material.parse(payload);
        const previous = input.materials.entries.find((entry) => entry.source === 'memories');
        const parts = [`离线演示：收到“${input.query.content}”。`, previous ? `已有活跃记忆：“${previous.value.content}”。` : '暂无活跃记忆。'];
        if (request.stream) for (const part of parts) controls.emit?.(part);
        return reply(parts.join(''));
      }
      if (request.responseFormat !== 'json_object') throw new Error('Demo does not implement this request');
      const input = extraction.parse(payload);
      const latest = input.messages.findLast(({ message }) => message.role === 'user');
      if (!latest) throw new Error('Demo extraction requires a formal user message');
      const previous = input.memories.find((memory) => memory.topic === '离线演示输入');
      const changes = previous?.content === latest.message.content ? [] : [{ action: previous ? 'update' : 'create', memoryId: previous?.id ?? null, change: '离线演示固定策略：保存最近用户输入', sourceIndexes: [latest.index], result: { topic: '离线演示输入', content: latest.message.content, sourceIndexes: [latest.index] } }];
      return reply(JSON.stringify({ changes }));
    },
  };
}
