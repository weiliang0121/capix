import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicMessagesProvider, ChatCompletionsProvider, GeminiGenerateContentProvider, OpenAIResponsesProvider, maximumFeedbackImages, requireToolFeedback } from '@weiliang0121/capix-model-provider';

test('full feedback budgets bound the number of smallest admissible images, including escaped IDs and separators', () => {
  const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
  for (const toolCallId of ['a', '"\\雪'.repeat(70)]) {
    for (const count of [1, 2, 31, 32]) {
      const feedback = requireToolFeedback({ toolCallId, status: 'ok', content: Array(count).fill(image) });
      const bytes = Buffer.byteLength(JSON.stringify(feedback));
      assert.equal(maximumFeedbackImages(toolCallId, bytes), count);
      assert.equal(maximumFeedbackImages(toolCallId, bytes - 1), count - 1);
    }
  }
});

test('wire reservation rejects inconsistent omission metadata, nonempty placeholders and duplicate identities', () => {
  const provider = new ChatCompletionsProvider({ endpoint: 'https://offline.invalid', model: 'm', apiKey: 'offline' });
  const slot = { toolCallId: 'a', maxBytes: 1024 };
  const feedback = { toolCallId: 'a', status: 'ok', content: [{ kind: 'text', text: '' }] };
  const reply = { formatVersion: 1, id: 'reply', model: 'm', output: [{ kind: 'tool-call', id: 'a', name: 'lookup', arguments: { encoding: 'json-text', text: '{}' } }], termination: { kind: 'completed', reason: 'tool_calls' }, native: { format: 'chat-completions', version: 1 }, usage: null };
  const request = { messages: [{ role: 'user', content: 'test' }], exchanges: [{ reply, feedback: [feedback] }] };
  const reservation = { feedback: [slot], contextGrowthBytes: 0, imageOmissionBytes: 2, imageOmissionByExchange: [2] };
  assert.ok(provider.reserveWireBytes(request, reservation) >= provider.inspectRequest(request).wireBytes);
  for (const wrong of [{ feedback: [slot, slot] }, { feedback: [{ ...slot, toolCallId: 'b' }] }, { imageOmissionBytes: 3 }, { imageOmissionByExchange: [1, 1] }, { mutableContext: false }]) assert.throws(() => provider.reserveWireBytes(request, { ...reservation, ...wrong }));
  feedback.content[0].text = 'already installed';
  assert.throws(() => provider.reserveWireBytes(request, reservation));
});

test('mutable context reserves native image and text blocks even with zero common byte growth', () => {
  const configuration = { endpoint: 'https://offline.invalid', model: 'm', apiKey: 'offline', bindingId: 'fixture' };
  const providers = [new ChatCompletionsProvider(configuration), new AnthropicMessagesProvider({ ...configuration, anthropicVersion: '2023-06-01', maxTokens: 4096 }), new OpenAIResponsesProvider({ ...configuration, continuation: 'replay' })];
  const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
  const text = { kind: 'text', text: '' };
  for (const provider of providers) {
    for (const parts of [[image], [text, image, text], Array(32).fill(image)]) {
      const current = { messages: [{ role: 'user', content: 'x'.repeat(JSON.stringify(parts).length - 2) }] };
      const next = { messages: [{ role: 'user', content: parts }] };
      const base = provider.inspectRequest(current);
      const actual = provider.inspectRequest(next);
      assert.equal(actual.requestBytes, base.requestBytes);
      assert.ok(actual.wireBytes > base.wireBytes);
      const bound = provider.reserveWireBytes(current, { feedback: [], contextGrowthBytes: 0, mutableContext: true });
      assert.ok(bound >= actual.wireBytes, `${provider.constructor.name} reserved ${bound} for a ${actual.wireBytes}-byte body`);
    }
  }
});

test('one optional context message can change role, merge into the system prefix or grow a part', () => {
  const config = { endpoint: 'https://offline.invalid/models/m:generateContent', model: 'm', apiKey: 'offline', bindingId: 'fixture' };
  const providers = [new ChatCompletionsProvider(config), new AnthropicMessagesProvider({ ...config, anthropicVersion: '2023-06-01', maxTokens: 4096 }), new OpenAIResponsesProvider({ ...config, continuation: 'replay' }), new GeminiGenerateContentProvider(config)];
  const text = { kind: 'text', text: '' };
  const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
  const user = { role: 'user', content: 'base' };
  const system = { role: 'system', content: 'fixed' };
  const withContext = (prefix, role, content) => ({ messages: role === 'system' ? [...prefix, { role, content }, user] : [...prefix, user, { role, content }] });
  for (const provider of providers) {
    for (const prefix of [[], [system]]) {
      const pairs = [
        [withContext(prefix, 'system', [text, text]), withContext(prefix, 'user', 'x'.repeat(53))],
        [withContext(prefix, 'assistant', 'x'.repeat(53)), withContext(prefix, 'system', [text, text])],
        [withContext(prefix, 'user', [image, text]), withContext(prefix, 'user', [image, text, image])],
      ];
      for (const [before, after] of pairs) {
        const base = provider.inspectRequest(before);
        const actual = provider.inspectRequest(after);
        const bound = provider.reserveWireBytes(before, { feedback: [], contextGrowthBytes: Math.max(0, actual.requestBytes - base.requestBytes), mutableContext: true });
        assert.ok(bound >= actual.wireBytes, `${provider.constructor.name} reserved ${bound} for a ${actual.wireBytes}-byte body`);
      }
    }
  }
});
