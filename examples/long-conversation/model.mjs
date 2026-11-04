import { randomUUID } from 'node:crypto';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { textBytes } from './measurement.mjs';

// Fixture facts are an explicit test script, never a second source of truth for live requests.
export function createFixtureModel(turns) {
  const byInput = new Map(turns.map((turn) => [turn.input, turn]));
  return {
    async complete(request, controls = {}) {
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      if (request.responseFormat === 'text') {
        const text = `离线装配占位回复：已收到“${input.query.content}”。本次载入 ${input.materials.entries.length} 项材料。这里使用固定响应验证消息、记忆、视图、交互与恢复数据的流转；它没有执行意图推理，也不代表真实模型能够正确回答本题。真实语义结果需单独运行并人工核对。`;
        for (let index = 0; index < text.length; index += 24) controls.emit?.(text.slice(index, index + 24));
        return reply(text);
      }
      if (request.responseFormat !== 'json_object') throw new Error('Unexpected fixture request');
      const latest = input.messages.findLast(({ message }) => message.role === 'user');
      const turn = byInput.get(latest.message.content);
      if (!turn) throw new Error('Fixture has no such submission');
      const changes = turn.memoryUpdates.map((update) => {
        const existing = input.memories.find((item) => item.topic === update.topic);
        const sourceIndexes = update.sourceTurns.map((number) => (number - 1) * 2);
        return { action: existing ? 'update' : 'create', memoryId: existing?.id ?? null, change: '离线脚本落实本次材料中的显式事实', sourceIndexes, result: { topic: update.topic, content: update.content, sourceIndexes } };
      });
      return reply(JSON.stringify({ changes }));
    },
  };
}

function reply(text) {
  return { id: randomUUID(), model: 'offline-long-conversation', text, finishReason: 'stop', usage: null };
}

export function createLiveModel(onBody) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('Live mode requires DEEPSEEK_API_KEY');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  return {
    name: model,
    provider: new ChatCompletionsProvider({
      endpoint: 'https://api.deepseek.com/chat/completions',
      apiKey,
      model,
      thinking: 'disabled',
      timeoutMs: 45_000,
      fetch(url, init) {
        // Count the actual serialized request body; never inspect or save Authorization.
        onBody(textBytes(init.body));
        return globalThis.fetch(url, init);
      },
    }),
  };
}
