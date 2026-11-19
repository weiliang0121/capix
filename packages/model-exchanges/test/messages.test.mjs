import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { AnthropicMessagesProvider, modelReplyUsage } from '@weiliang0121/capix-model-provider';

test('a Messages exchange restores offline and encodes feedback in call order when results arrived in reverse', async () => {
  const requests = [];
  const content = [
    { type: 'thinking', thinking: 'Look up records.', signature: 'fixture-signature' },
    { type: 'tool_use', id: 'first', name: 'lookup', input: { key: 1 } },
    { type: 'text', text: 'And one more.' },
    { type: 'tool_use', id: 'second', name: 'lookup', input: { key: 2 } },
  ];
  const provider = new AnthropicMessagesProvider({
    endpoint: 'https://fixture.invalid/v1/messages',
    apiKey: 'fixture',
    model: 'fixture',
    bindingId: 'test-deployment',
    anthropicVersion: '2023-06-01',
    maxTokens: 4096,
    async fetch(_url, { body }) {
      requests.push(JSON.parse(body));
      const first = requests.length === 1;
      return Response.json({ type: 'message', id: first ? 'msg_01' : 'msg_02', role: 'assistant', model: 'fixture', content: first ? content : [{ type: 'text', text: 'done' }], stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2 } });
    },
  });
  const entity = new ModelExchanges();
  const origin = entity.begin('calls', { request: { messages: [{ role: 'user', content: 'read two records' }] }, catalog: { tools: [{ name: 'lookup', description: 'Look up a record.', parameters: { type: 'object' } }], digest: 'fixture-tools', policyVersion: '1' } });
  const first = await provider.complete(entity.request({ origin, exchanges: [] }));
  const operation = { parentContextId: 'parent', childContextId: 'model', position: 'receive' };
  const opened = entity.intake(origin, operation, first);
  const secondSlot = entity.complete(origin, opened, 'second', { status: 'error', content: [{ kind: 'text', text: 'missing record' }] });
  assert.throws(() => entity.request({ origin, exchanges: [secondSlot] }), /missing/i);
  const closed = entity.complete(origin, secondSlot, 'first', { status: 'ok', content: [{ kind: 'text', text: 'first record' }] });
  const snapshot = JSON.parse(JSON.stringify(entity.snapshot()));
  const restored = ModelExchanges.restore(snapshot, { persistence: { commit: () => assert.fail('cold read wrote data') } });
  assert.deepEqual(restored.snapshot(), snapshot);
  const next = restored.request({ origin, exchanges: [closed] });
  assert.deepEqual(next.exchanges[0].reply.native.partialUsage, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2 });
  assert.deepEqual(modelReplyUsage(next.exchanges[0].reply), { completionTokens: 5, promptCacheWriteTokens: 2 });
  assert.deepEqual(
    next.exchanges[0].feedback.map((item) => item.toolCallId),
    ['second', 'first'],
  );
  await provider.complete(next);
  assert.deepEqual(requests[1].messages[1], { role: 'assistant', content });
  const feedback = requests[1].messages[2].content;
  assert.deepEqual(
    feedback.map((item) => [item.tool_use_id, item.is_error === true]),
    [
      ['first', false],
      ['second', true],
    ],
  );
  for (const mutate of [
    ...[{}, { output_tokens: -1 }, { output_tokens: null }, { unknown: 1 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }].map((counts) => (reply) => {
      reply.native.partialUsage = counts;
    }),
    (reply) => {
      reply.usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    },
    (reply) => {
      reply.native.version++;
    },
    (reply) => {
      delete reply.native.blocks[0].signature;
    },
    (reply) => {
      reply.native.blocks[1].index = 1;
    },
    (reply) => {
      reply.output[0].arguments = { encoding: 'json-text', text: '{}' };
    },
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid.entries[0].reply);
    const original = structuredClone(invalid);
    assert.throws(() => ModelExchanges.restore(invalid));
    assert.deepEqual(invalid, original);
  }
});
