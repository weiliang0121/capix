import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { assembly, host, input, member, result } from './fixture.mjs';

// Auth, endpoint availability and model access are outside these offline wire fixtures.
// https://api-docs.deepseek.com/guides/tool_calls/
// https://help.aliyun.com/zh/model-studio/qwen-function-calling
const services = [
  { name: 'DeepSeek', endpoint: 'https://deepseek.invalid/chat/completions', model: 'deepseek-chat', reasoning: 'Look up the record.', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 9, prompt_cache_miss_tokens: 11 } },
  { name: 'Qwen', endpoint: 'https://dashscope.invalid/compatible-mode/v1/chat/completions', model: 'qwen-plus', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 9 } } },
];

function chatResponse(service, round, stream, toolName = 'lookup') {
  const base = { id: `reply-${round}`, model: service.model };
  const call = { id: 'call_' + toolName, type: 'function', function: { name: toolName, arguments: '{"key":"词"}' } };
  const reason = round === 1 ? 'tool_calls' : 'stop';
  const reasoning = round === 1 && service.reasoning ? { reasoning_content: service.reasoning } : {};
  if (!stream) {
    const message = round === 1 ? { role: 'assistant', content: null, tool_calls: [call], ...reasoning } : { role: 'assistant', content: '找到' };
    return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0, finish_reason: reason, message }], usage: service.usage });
  }
  const deltas = round === 1 ? [{ role: 'assistant', ...reasoning }, { tool_calls: [{ ...call, index: 0, function: { name: toolName, arguments: '{"key":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"词"}' } }] }] : [{ role: 'assistant', content: '找' }, { content: '到' }];
  const chunk = (choices, usage = null) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, usage })}\n\n`;
  const data = deltas.map((delta) => chunk([{ index: 0, delta, finish_reason: null }])).join('') + chunk([{ index: 0, delta: {}, finish_reason: reason }]) + chunk([], service.usage) + 'data: [DONE]\n\n';
  return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
}

for (const scenario of [
  { name: 'auto', choice: 'auto', wireChoice: 'auto', called: 'lookup', feedbackText: 'current record 词' },
  { name: 'named', choice: { name: 'lookup_archive' }, wireChoice: { type: 'function', function: { name: 'lookup_archive' } }, called: 'lookup_archive', feedbackText: 'archived record 词' },
]) {
  test(`Tool preserves ${scenario.name} Chat Completions choice and dispatches the returned call`, async () => {
    const service = services[0];
    const requests = [];
    const effects = [];
    const provider = new ChatCompletionsProvider({
      endpoint: service.endpoint,
      model: service.model,
      apiKey: 'offline',
      async fetch(_url, init) {
        assert.equal(init.method, 'POST');
        requests.push(JSON.parse(init.body));
        assert.ok(requests.length <= 2);
        return chatResponse(service, requests.length, false, scenario.called);
      },
    });
    const local = host((request) => provider.complete(request));
    const tools = {
      lookup: member('lookup', ({ key }) => {
        effects.push(['lookup', key]);
        return { text: 'current record ' + key };
      }),
      lookup_archive: member('lookup_archive', ({ key }) => {
        effects.push(['lookup_archive', key]);
        return { text: 'archived record ' + key };
      }),
    };
    const { runner, entity } = assembly({ policyVersion: 'choice.v1', tools }, local, { inspection: provider });
    try {
      assert.equal(await runner.run({ request: { ...input.request, toolChoice: scenario.choice } }), '找到');
      assert.deepEqual(effects, [[scenario.called, '词']]);
      assert.equal(requests.length, 2);
      assert.deepEqual(entity.snapshot().origins[0].request.toolChoice, scenario.choice);
      for (const body of requests) {
        assert.deepEqual(body.tool_choice, scenario.wireChoice);
        assert.deepEqual(body.tools.map(({ function: definition }) => definition.name).sort(), ['lookup', 'lookup_archive']);
      }
      const toolCallId = 'call_' + scenario.called;
      const feedback = result(scenario.feedbackText);
      const [, assistant, tool] = requests[1].messages;
      assert.deepEqual(assistant.tool_calls, [{ id: toolCallId, type: 'function', function: { name: scenario.called, arguments: '{"key":"词"}' } }]);
      assert.equal(tool.role, 'tool');
      assert.equal(tool.tool_call_id, toolCallId);
      assert.deepEqual(JSON.parse(tool.content), feedback);
      assert.deepEqual(entity.values()[0].feedback, [{ toolCallId, ...feedback }]);
    } finally {
      await local.interactions.settled();
      local.interactions.close();
    }
  });
}

for (const service of services) {
  for (const stream of [false, true]) {
    test(`${service.name} Chat Completions fixture completes a two-round Tool run with ${stream ? 'SSE' : 'JSON'}`, async () => {
      const bodies = [];
      const provider = new ChatCompletionsProvider({
        endpoint: service.endpoint,
        apiKey: 'offline',
        model: service.model,
        async fetch(url, init) {
          assert.equal(url, service.endpoint);
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline');
          bodies.push(init.body);
          assert.ok(bodies.length <= 2);
          return chatResponse(service, bodies.length, stream);
        },
      });
      const serviceHost = host((request) => provider.complete(request));
      const lookedUp = [];
      const tool = member('lookup', ({ key }) => {
        lookedUp.push(key);
        return { text: 'result ' + key };
      });
      const { runner, entity } = assembly({ policyVersion: 'chat-endpoint-fixtures.v1', tools: { lookup: tool } }, serviceHost, { inspection: provider });
      try {
        assert.equal(await runner.run({ request: { messages: [{ role: 'user', content: 'lookup' }], stream } }), '找到');
        assert.deepEqual(lookedUp, ['词']);
        assert.equal(bodies.length, 2);
        for (const [index, raw] of bodies.entries()) {
          assert.equal(provider.inspectRequest(serviceHost.sent[index]).wireBytes, Buffer.byteLength(raw));
          const body = JSON.parse(raw);
          assert.equal(body.model, service.model);
          assert.equal(body.stream, stream);
          assert.deepEqual(body.stream_options, stream ? { include_usage: true } : undefined);
          assert.equal(body.tools[0].function.name, 'lookup');
        }
        const [, assistant, response] = JSON.parse(bodies[1]).messages;
        assert.equal(assistant.reasoning_content, service.reasoning);
        assert.deepEqual(assistant.tool_calls, [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"key":"词"}' } }]);
        assert.equal(response.role, 'tool');
        assert.equal(response.tool_call_id, 'call_lookup');
        assert.deepEqual(JSON.parse(response.content), { status: 'ok', content: [{ kind: 'text', text: 'result 词' }] });
        const first = entity.values()[0];
        assert.equal(first.reply.native.format, 'chat-completions');
        const usage = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };
        if (service.usage.prompt_cache_hit_tokens !== undefined) {
          usage.promptCacheHitTokens = service.usage.prompt_cache_hit_tokens;
          usage.promptCacheMissTokens = service.usage.prompt_cache_miss_tokens;
        } else if (service.usage.prompt_tokens_details) usage.promptCacheHitTokens = service.usage.prompt_tokens_details.cached_tokens;
        assert.deepEqual(first.reply.usage, usage);
        assert.equal(first.feedback[0].toolCallId, 'call_lookup');
      } finally {
        await serviceHost.interactions.settled();
        serviceHost.interactions.close();
      }
    });
  }
}
