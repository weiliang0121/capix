import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, maximumFeedbackImages, requireToolFeedback } from '@weiliang0121/capix-model-provider';

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
