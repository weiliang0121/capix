import { randomUUID } from 'node:crypto';
import { ChatCompletionsProvider, type ModelProvider, type ModelReply, type ModelRequest } from '@capix/model-provider';
import { z } from 'zod';

const material = z.object({ query: z.object({ content: z.string() }), materials: z.object({ entries: z.array(z.object({ source: z.enum(['messages', 'memories']), value: z.object({ content: z.string() }) })) }) });
const extraction = z.object({ messages: z.array(z.object({ index: z.number().int().nonnegative(), message: z.object({ role: z.enum(['user', 'assistant']), content: z.string() }) })), memories: z.array(z.object({ id: z.string(), topic: z.string(), content: z.string() })) });

/** A deterministic teaching fixture. It stores the last input, not an inferred preference. */
export function createDemoModel(): ModelProvider {
  // The offline fixture uses the same request encoding limits; its transport is
  // deliberately unavailable. Actual live protocol compatibility is tested separately.
  const encoder = new ChatCompletionsProvider({
    endpoint: 'https://offline.invalid/chat/completions',
    apiKey: 'offline-fixture',
    model: 'offline-demo',
    fetch: async () => {
      throw new Error('Offline demo cannot send requests');
    },
  });
  const reply = (text: string): ModelReply => ({ id: randomUUID(), model: 'offline-demo', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
  return {
    inspectRequest: (request) => encoder.inspectRequest(request),
    async complete(request, controls = {}) {
      controls.signal?.throwIfAborted();
      encoder.inspectRequest(request);
      const encoded = request.messages.find((message) => message.role === 'user')?.content;
      if (encoded === undefined) throw new Error('Demo requires the service material payload');
      const payload: unknown = JSON.parse(encoded);
      if (request.tools?.length) return toolReply(request, material.parse(payload).query.content, reply);
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

/** A fixed search → read → answer script, not an intent-quality demonstration. */
function toolReply(request: ModelRequest, query: string, reply: (text: string) => ModelReply): ModelReply {
  const exchanges = request.exchanges ?? [];
  const call = (name: string, input: object): ModelReply => ({ formatVersion: 1, id: randomUUID(), model: 'offline-demo', output: [{ kind: 'tool-call', id: randomUUID(), name, arguments: { encoding: 'json-text', text: JSON.stringify(input) } }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'tool_calls' }, usage: null });
  if (exchanges.length === 0) return call('search_history', { query, limit: 3 });
  const feedback = exchanges.at(-1)?.feedback[0];
  if (!feedback || feedback.status !== 'ok') return reply('离线演示：历史工具没有返回可用材料。');
  const value: unknown = JSON.parse(feedback.content.map((part) => part.text).join(''));
  if (exchanges.length === 1) {
    const search = z.object({ matches: z.array(z.object({ index: z.number() })) }).parse(value);
    const first = search.matches[0];
    return first ? call('read_message', { index: first.index, offset: 0, length: 256 }) : reply(`离线演示：收到“${query}”，此前历史中没有匹配内容。`);
  }
  const message = z.object({ index: z.number(), text: z.string() }).parse(value);
  return reply(`离线演示：历史消息 #${message.index} 的原文片段是“${message.text}”。`);
}
