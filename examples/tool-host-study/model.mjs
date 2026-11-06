import { randomUUID } from 'node:crypto';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { createYieldingFetch } from '@capix/conversation-service/assembly';

export function studyModel({ live, thinking, modelCalls = 3, toolSlots = 1, metrics, onDispatch }) {
  const name = live ? process.env.DEEPSEEK_MODEL || 'deepseek-flash' : 'offline-tool-host';
  if (live && !process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Live study requires DEEPSEEK_API_KEY');
  const fixtureFetch = async (_url, init) => {
    init.signal?.throwIfAborted();
    const request = JSON.parse(init.body);
    if (!request.tools?.length) return wireReply({ content: '{"changes":[]}' }, 'stop');
    const completed = request.messages.filter((message) => message.role === 'assistant' && message.tool_calls).length;
    if (completed >= modelCalls - 1) return wireReply({ content: '离线完成：工具链路已经执行。' }, 'stop');
    const calls = Array.from({ length: toolSlots }, (_value, index) => ({ id: `call-${completed}-${index}`, type: 'function', function: { name: 'read_message', arguments: JSON.stringify({ index: 0, offset: 0, length: 1024 }) } }));
    return wireReply({ content: null, tool_calls: calls }, 'tool_calls');
  };
  const transport = live ? globalThis.fetch : fixtureFetch;
  const fetcher = createYieldingFetch((url, init) => {
    const pending = transport(url, init);
    onDispatch?.();
    return pending;
  });
  const provider = new ChatCompletionsProvider({
    endpoint: live ? 'https://api.deepseek.com/chat/completions' : 'https://fixture.invalid/chat/completions',
    apiKey: live ? process.env.DEEPSEEK_API_KEY : 'offline-fixture',
    model: name,
    thinking,
    timeoutMs: 45_000,
    fetch: async (url, init) => {
      // Only the body size is measured. Credentials and headers never enter reports.
      metrics.wireBytes += Buffer.byteLength(init.body);
      return fetcher(url, init);
    },
  });
  return {
    name,
    provider: {
      inspectRequest: (request) => provider.inspectRequest(request),
      async complete(request, controls) {
        const started = performance.now();
        const row = { kind: request.tools?.length ? 'tools' : 'memory', exchanges: request.exchanges?.length ?? 0, requestBytes: Buffer.byteLength(JSON.stringify(request)) };
        metrics.requests.push(row);
        try {
          const result = await provider.complete(request, controls);
          Object.assign(row, { elapsedMs: performance.now() - started, replyBytes: Buffer.byteLength(JSON.stringify(result)), usage: result.usage, reasoningBytes: Buffer.byteLength(result.native.reasoningContent ?? ''), toolCalls: result.output.filter((part) => part.kind === 'tool-call').map((part) => ({ name: part.name, arguments: part.arguments.text })), textCharacters: result.output.filter((part) => part.kind === 'text').reduce((sum, part) => sum + part.text.length, 0) });
          return result;
        } catch (error) {
          Object.assign(row, { elapsedMs: performance.now() - started, error: error?.code ?? error?.name ?? 'unknown' });
          throw error;
        }
      },
    },
  };
}

function wireReply(message, reason) {
  return Response.json({ id: randomUUID(), model: 'offline-tool-host', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
}
