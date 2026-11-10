import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, ProviderError } from '@weiliang0121/capix-model-provider';

const baseUsage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

const expectedUsage = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };

const messages = [{ role: 'user', content: 'fixture prompt' }];

const identity = { id: 'reply', model: 'fixture' };

const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

async function complete(transport, usage) {
  const model = new ChatCompletionsProvider({
    endpoint: 'https://provider.example/chat/completions',
    apiKey: 'fixture-key',
    model: 'fixture',
    fetch: async () => {
      if (transport === 'json') return Response.json({ ...identity, usage, choices: [{ index: 0, message: { content: 'answer' }, finish_reason: 'stop' }] });
      const final = { ...identity, choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] };
      const wire = transport === 'sse-attached' ? event({ ...final, usage }) : event(final) + event({ ...identity, choices: [], usage });
      return new Response(wire + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return model.complete({ messages, stream: transport !== 'json' });
}

for (const transport of ['json', 'sse-attached', 'sse-separate']) {
  test(`${transport} preserves optional reported DeepSeek cache usage without inventing missing counts`, async () => {
    for (const [fields, normalized] of [
      [{}, {}],
      [{ prompt_cache_hit_tokens: 0 }, { promptCacheHitTokens: 0 }],
      [{ prompt_cache_miss_tokens: 20 }, { promptCacheMissTokens: 20 }],
      [
        { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 },
        { promptCacheHitTokens: 0, promptCacheMissTokens: 20 },
      ],
      [
        { prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 0 },
        { promptCacheHitTokens: 20, promptCacheMissTokens: 0 },
      ],
      [
        { prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8 },
        { promptCacheHitTokens: 12, promptCacheMissTokens: 8 },
      ],
      // Other providers' fields do not implicitly become DeepSeek cache counts.
      [{ prompt_tokens_details: { cached_tokens: 10 } }, {}],
    ]) {
      const reply = await complete(transport, { ...baseUsage, ...fields });
      assert.deepEqual(reply.usage, { ...expectedUsage, ...normalized });
      assert.ok(Object.isFrozen(reply.usage));
      assert.equal(Object.hasOwn(reply.usage, 'promptCacheHitTokens'), Object.hasOwn(normalized, 'promptCacheHitTokens'));
      assert.equal(Object.hasOwn(reply.usage, 'promptCacheMissTokens'), Object.hasOwn(normalized, 'promptCacheMissTokens'));
    }
    const empty = await complete(transport, { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });
    assert.equal(empty.usage.promptCacheHitTokens, 0);
    assert.equal(empty.usage.promptCacheMissTokens, 0);
  });

  test(`${transport} rejects invalid cache counts and inconsistent prompt partitions`, async () => {
    const invalid = [];
    for (const field of ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
      for (const value of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1, 21]) invalid.push({ [field]: value });
    }
    invalid.push({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 9 }, { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 11 });
    for (const fields of invalid) await assert.rejects(complete(transport, { ...baseUsage, ...fields }), (error) => error instanceof ProviderError && error.code === 'ENVELOPE');
  });
}
