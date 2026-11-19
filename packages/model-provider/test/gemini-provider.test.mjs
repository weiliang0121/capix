import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertModelContinuation, GeminiGenerateContentProvider } from '@weiliang0121/capix-model-provider';

const model = 'gemini-test';
const endpoint = 'https://offline.invalid/proxy/v1beta/models/gemini-test:generateContent?tenant=lab';
const config = { endpoint, apiKey: 'offline', model, bindingId: 'lab' };
const text = (text) => ({ kind: 'text', text });
const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
const inlineImage = { inlineData: { mimeType: image.mimeType, data: image.data } };
const tool = { name: 'lookup', description: 'Read a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
const request = {
  messages: [
    { role: 'system', content: 'first' },
    { role: 'system', content: [text('second')] },
    { role: 'user', content: [text('one'), image] },
  ],
  tools: [tool],
  toolChoice: { name: 'lookup' },
  maxTokens: 400,
  temperature: 0,
};
const wireReply = (parts, reason = 'STOP') => ({ responseId: 'r1', modelVersion: 'gemini-test-001', candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: reason }] });
const parallelParts = [{ thought: true, text: 'summary' }, { functionCall: { id: 'upstream-42', name: 'lookup', args: { key: 'first' } }, thoughtSignature: 'c2ln' }, { functionCall: { name: 'lookup' } }];
function fixture(parts = [{ text: 'done' }]) {
  const sent = [];
  const provider = new GeminiGenerateContentProvider({
    ...config,
    fetch: async (url, init) => {
      sent.push({ url, ...init });
      return Response.json(wireReply(parts));
    },
  });
  return { provider, sent };
}

test('Gemini measures and sends native instructions, catalog, selection, image and generation options', async () => {
  const { provider, sent } = fixture();
  const inspection = provider.inspectRequest(request);
  assert.equal(sent.length, 0);
  const reply = await provider.complete(request);
  assert.deepEqual(reply.output, [text('done')]);
  const [actual] = sent;
  assert.equal(actual.url, endpoint);
  assert.equal(actual.redirect, 'error');
  assert.equal(actual.headers['x-goog-api-key'], config.apiKey);
  assert.equal(actual.headers.Authorization, undefined);
  assert.equal(inspection.wireBytes, Buffer.byteLength(actual.body));
  assert.deepEqual(JSON.parse(actual.body), {
    systemInstruction: { parts: [{ text: 'first' }, { text: 'second' }] },
    contents: [{ role: 'user', parts: [{ text: 'one' }, inlineImage] }],
    tools: [{ functionDeclarations: [{ name: 'lookup', description: tool.description, parametersJsonSchema: tool.parameters }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
    generationConfig: { maxOutputTokens: 400, temperature: 0 },
  });
  for (const [choice, mode] of [
    ['auto', 'AUTO'],
    ['none', 'NONE'],
    ['required', 'ANY'],
  ]) {
    await provider.complete({ ...request, toolChoice: choice });
    assert.deepEqual(JSON.parse(sent.at(-1).body).toolConfig, { functionCallingConfig: { mode } });
  }
  await provider.complete({ messages: request.messages, responseFormat: 'json_object' });
  const json = JSON.parse(sent.at(-1).body);
  assert.equal(json.generationConfig.responseMimeType, 'application/json');
  assert.equal(json.generationConfig.responseJsonSchema.type, 'object');
});

test('Gemini replays whole signed parts and closes same-name parallel calls by their original ID or ordered position', async () => {
  const { provider, sent } = fixture(parallelParts);
  const reply = await provider.complete(request);
  const [first, second] = reply.output;
  assert.notEqual(first.id, second.id);
  const feedback = [
    { toolCallId: second.id, status: 'error', content: [text('second failed')] },
    { toolCallId: first.id, status: 'ok', content: [text('before'), image, text('after')] },
  ];
  const next = { ...request, messages: [...request.messages, { role: 'user', content: 'Updated context' }], exchanges: [{ reply: JSON.parse(JSON.stringify(reply)), feedback }] };
  assertModelContinuation(next, { feedback: [], contextGrowthBytes: 99, mutableContext: true });
  await provider.complete(next);
  const turns = JSON.parse(sent.at(-1).body).contents;
  assert.deepEqual(turns.at(-2), { role: 'model', parts: parallelParts });
  assert.deepEqual(turns.at(-1), { role: 'user', parts: [{ functionResponse: { name: 'lookup', id: 'upstream-42', response: { output: [text('before'), { $ref: 'image-0' }, text('after')] }, parts: [{ inlineData: { ...inlineImage.inlineData, displayName: 'image-0' } }] } }, { functionResponse: { name: 'lookup', response: { error: [text('second failed')] } } }] });
  const changed = structuredClone(next);
  changed.exchanges[0].reply.output[0].arguments.value.key = 'different';
  assert.throws(() => provider.inspectRequest(changed), { code: 'REQUEST' });
  assert.throws(() => new GeminiGenerateContentProvider({ ...config, bindingId: 'another' }).inspectRequest(next), { code: 'REQUEST' });
});

test('Gemini wire reservation bounds replacement with large mixed multimodal results including full 32-part batches', async () => {
  const { provider } = fixture([{ functionCall: { name: 'lookup' } }]);
  const reply = await provider.complete(request);
  const { id: toolCallId } = reply.output[0];
  const projected = (result) => ({ ...request, exchanges: [{ reply, feedback: [{ toolCallId, ...result }] }] });
  for (const n of [1, 2, 16, 32]) {
    const placeholder = projected({ status: 'ok', content: [text('')] });
    for (const content of [Array(n).fill(image), Array.from({ length: n }, (_, i) => (i % 2 ? image : text('"\\雪'.repeat(20))))]) {
      const actual = projected({ status: 'error', content });
      const maxBytes = Buffer.byteLength(JSON.stringify(actual.exchanges[0].feedback[0]));
      const upper = provider.reserveWireBytes(placeholder, { feedback: [{ toolCallId, maxBytes }], contextGrowthBytes: 0 });
      assert.ok(upper >= provider.inspectRequest(actual).wireBytes);
    }
  }
});

test('Gemini stream changes only the method and SSE query, preserving the configured proxy path and tenant', async () => {
  let sent;
  const provider = new GeminiGenerateContentProvider({
    ...config,
    fetch: async (url, options) => {
      sent = { url, options };
      const data = JSON.stringify(wireReply([{ text: 'preview' }]));
      return new Response('data: ' + data + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const seen = [];
  const reply = await provider.complete(
    { ...request, stream: true },
    {
      emit: (part) => {
        seen.push(part);
      },
    },
  );
  assert.deepEqual(seen, ['preview']);
  assert.deepEqual(reply.output, [text('preview')]);
  assert.equal(sent.url, endpoint.replace(':generateContent?', ':streamGenerateContent?') + '&alt=sse');
  assert.equal(sent.options.redirect, 'error');
  assert.equal('stream' in JSON.parse(sent.options.body), false);
});

test('Gemini rejects malformed endpoints and unsupported projections locally', async () => {
  for (const wrong of [endpoint.replace(':generateContent', ':chat'), endpoint.replace(model, 'different'), endpoint + '#secret', 'https://user@host/models/gemini-test:generateContent', 'invalid']) assert.throws(() => new GeminiGenerateContentProvider({ ...config, endpoint: wrong }), { code: 'CONFIGURATION' });
  const { provider, sent } = fixture();
  for (const invalid of [
    { ...request, messages: [request.messages[2], request.messages[0]] },
    { ...request, messages: [request.messages[0]] },
    { ...request, tools: [{ ...tool, parameters: { type: 'string' } }] },
    { ...request, toolChoice: 'auto', tools: [{ ...tool, name: '-invalid' }] },
    { ...request, messages: [{ role: 'user', content: [{ kind: 'image', data: 'http://offline.invalid/image', mimeType: image.mimeType }] }] },
  ]) {
    await assert.rejects(provider.complete(invalid), { code: 'REQUEST' });
  }
  assert.equal(sent.length, 0);
});
