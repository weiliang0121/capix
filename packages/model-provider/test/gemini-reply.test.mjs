import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiGenerateContentProvider, requireModelReply } from '@weiliang0121/capix-model-provider';

const request = { messages: [{ role: 'user', content: 'lookup' }] };
const makeProvider = (fetch) => new GeminiGenerateContentProvider({ endpoint: 'https://offline.invalid/v1beta/models/test:generateContent', apiKey: 'key', model: 'test', bindingId: 'fixture', fetch });
const metadata = { responseId: 'response-1', modelVersion: 'served' };
const parts = [{ text: '思考', thought: true }, { text: 'looking', thought: false, thoughtSignature: 'signed-text' }, { functionCall: { name: 'search', args: { q: '中文', mode: [true, null] } }, thoughtSignature: 'signed-call' }, { functionCall: { name: 'search', id: 'vendor-call' } }, { text: '', thoughtSignature: 'empty-text-signature' }, { thoughtSignature: 'separate' }];
const usageMetadata = { promptTokenCount: 12, toolUsePromptTokenCount: 3, cachedContentTokenCount: 2, candidatesTokenCount: 6, thoughtsTokenCount: 5, totalTokenCount: 26 };
const envelope = (parts, finishReason = 'STOP', extra = {}) => ({ ...metadata, candidates: [{ index: 0, content: { role: 'model', parts }, finishReason }], ...extra });
const jsonReply = (body) => makeProvider(() => Response.json(body)).complete(request);

function stream(frames, { close = true, cancel } = {}) {
  const bytes = Buffer.from(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\r\n\r\n').join(''));
  const split = bytes.indexOf(Buffer.from('思')) + 1;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      if (close) controller.close();
    },
    cancel,
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Gemini JSON and fragmented SSE preserve each signed part, optional wire identities and object arguments', async () => {
  const expected = await jsonReply(envelope(parts, 'STOP', { usageMetadata }));
  let cancelled = 0;
  const frames = [{ ...metadata, candidates: [{ content: { parts: parts.slice(0, 2) } }] }, { candidates: [{ content: { parts: parts.slice(2) } }] }, { candidates: [{ finishReason: 'STOP' }], usageMetadata }];
  const text = [];
  const reasoning = [];
  const kinds = [];
  const response = stream(frames, { close: false, cancel: () => cancelled++ });
  const received = await makeProvider(() => response).complete({ ...request, stream: true }, { emit: (delta) => text.push(delta), emitReasoning: (delta) => reasoning.push(delta), progress: ({ kind }) => kinds.push(kind) });
  assert.deepEqual(received, expected);
  assert.equal(response.body.locked, false);
  assert.equal(cancelled, 1);
  assert.deepEqual(text, ['looking']);
  assert.deepEqual(reasoning, ['思考']);
  assert.deepEqual(kinds, ['reasoning', 'text', 'tool-call']);
  assert.deepEqual(received.usage, { promptTokens: 15, completionTokens: 11, totalTokens: 26, promptCacheHitTokens: 2 });
  assert.deepEqual(received.native.parts, [
    { kind: 'thought', text: '思考' },
    { kind: 'output', index: 0, thought: false, thoughtSignature: 'signed-text' },
    { kind: 'output', index: 1, thoughtSignature: 'signed-call' },
    { kind: 'output', index: 2, wireId: 'vendor-call', omittedArgs: true },
    { kind: 'output', index: 3, thoughtSignature: 'empty-text-signature' },
    { kind: 'signature', thoughtSignature: 'separate' },
  ]);
  assert.deepEqual(received.output[1].arguments, { encoding: 'json-value', value: parts[2].functionCall.args });
  assert.deepEqual(received.output[2].arguments, { encoding: 'json-value', value: {} });
  assert.notEqual(received.output[1].id, received.output[2].id);
  assert.notEqual(received.output[2].id, 'vendor-call');
  assert.notEqual((await jsonReply(envelope(parts, 'STOP', { responseId: 'response-2' }))).output[1].id, received.output[1].id);
  assert.ok(Object.isFrozen(received.output[1].arguments.value.mode));
});

test('Gemini accepts final usage after candidate completion and requires a clean ending', async () => {
  const prefix = { ...metadata, candidates: [{ content: { parts: [{ text: 'first' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } };
  const terminal = envelope([{ text: 'last' }]);
  const read = (frames) => makeProvider(() => stream(frames)).complete({ ...request, stream: true });
  const closed = await read([prefix, terminal]);
  assert.equal(closed.usage, null);
  assert.deepEqual(closed.output, [
    { kind: 'text', text: 'first' },
    { kind: 'text', text: 'last' },
  ]);
  let cancelled = 0;
  const usageFrame = { ...metadata, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } };
  const reply = await makeProvider(() => stream([prefix, terminal, usageFrame], { close: false, cancel: () => cancelled++ })).complete({ ...request, stream: true });
  assert.deepEqual(reply.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(cancelled, 1);
  for (const trailing of [prefix, terminal, { ...usageFrame, responseId: 'other' }, { ...usageFrame, modelVersion: 'other' }]) await assert.rejects(read([terminal, trailing]), { code: 'ENVELOPE' });
  const keepAlive = new Response('data: ' + JSON.stringify(terminal) + '\n\n: keepalive', { headers: { 'Content-Type': 'text/event-stream' } });
  const atEof = await makeProvider(() => keepAlive).complete({ ...request, stream: true });
  assert.equal(atEof.termination.kind, 'completed');
  assert.equal(atEof.usage, null);
  const cut = new Response('data: ' + JSON.stringify(terminal) + '\n\ndata: {"usageMetadata"', { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(makeProvider(() => cut).complete({ ...request, stream: true }), { code: 'ENVELOPE' });
});

test('Gemini accepts null intermediate finish reasons and optional reply identity on JSON and SSE terminals', async () => {
  const candidate = (text, finishReason) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }] });
  const finalUsage = { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 };
  const first = candidate('Hel', null);
  const second = candidate('lo', null);
  const terminal = { candidates: [{ finishReason: 'STOP' }], usageMetadata: finalUsage };
  const complete = { ...candidate('Hello', 'STOP'), usageMetadata: finalUsage };
  const read = (frames) => makeProvider(() => stream(frames)).complete({ ...request, stream: true });
  const failure = (phase, reason) => ({ code: 'ENVELOPE', diagnostic: { protocol: 'gemini-generate-content', phase, reason } });
  const localIds = new Set();
  for (const supplied of [{}, { responseId: 'vendor' }, { modelVersion: 'reported' }, metadata]) {
    const parsed = await jsonReply({ ...complete, ...supplied });
    const streamed = await read([{ ...first, ...supplied }, second, terminal]);
    for (const reply of [parsed, streamed]) {
      assert.equal(reply.output.map((item) => item.text).join(''), 'Hello');
      assert.equal(reply.native.model, 'test');
      assert.equal(reply.model, supplied.modelVersion ?? 'test');
      assert.equal(reply.native.modelSource, supplied.modelVersion ? undefined : 'configured');
      assert.equal(reply.native.idSource, supplied.responseId ? undefined : 'local');
      if (supplied.responseId) assert.equal(reply.id, supplied.responseId);
      else {
        assert.ok(reply.id.length);
        assert.ok(!localIds.has(reply.id));
        localIds.add(reply.id);
      }
      const persisted = JSON.parse(JSON.stringify(reply));
      assert.equal(requireModelReply(persisted), persisted);
    }
  }
  const accepted = await read([first, second, { ...terminal, ...metadata }]);
  assert.equal(accepted.id, metadata.responseId);
  assert.equal(accepted.model, metadata.modelVersion);
  assert.deepEqual(accepted.output, [
    { kind: 'text', text: 'Hel' },
    { kind: 'text', text: 'lo' },
  ]);
  assert.deepEqual(accepted.termination, { kind: 'completed', reason: 'STOP' });
  assert.deepEqual(accepted.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  await assert.rejects(jsonReply({ ...first, ...metadata }), failure('response', 'missing-terminal'));
  await assert.rejects(read([{ ...metadata, candidates: terminal.candidates }, first]), failure('stream', 'event-order'));
});

test('Gemini prompt blocking, candidate filters, truncated and unknown finish reasons retain their native cause', async () => {
  const blocked = { ...metadata, promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 } };
  const reply = await jsonReply(blocked);
  assert.deepEqual(await makeProvider(() => stream([blocked])).complete({ ...request, stream: true }), reply);
  assert.deepEqual(reply.termination, { kind: 'refused', reason: 'OTHER' });
  assert.equal(reply.native.promptBlocked, true);
  assert.deepEqual(reply.output, []);
  assert.deepEqual(reply.usage, { promptTokens: 2, completionTokens: 0, totalTokens: 2 });
  for (const [reason, kind] of [
    ['SAFETY', 'refused'],
    ['RECITATION', 'refused'],
    ['MAX_TOKENS', 'incomplete'],
    ['MALFORMED_FUNCTION_CALL', 'incomplete'],
    ['FUTURE_REASON', 'incomplete'],
  ]) {
    const reply = await jsonReply({ ...metadata, candidates: [{ finishReason: reason }] });
    assert.deepEqual(reply.termination, { kind, reason });
    assert.equal(reply.usage, null);
  }
});

test('Gemini rejects malformed envelopes, ambiguous call ids, partial arguments, invalid usage and premature EOF', async () => {
  for (const body of [{ ...metadata, candidates: [] }, envelope([], 'FINISH_REASON_UNSPECIFIED'), envelope([{ inlineData: { mimeType: 'image/png', data: '' } }]), envelope([{ text: 'x', functionCall: { name: 'search' } }]), envelope([{ functionCall: { name: 'search', partialArgs: [] } }]), envelope([{ functionCall: { name: 'search', args: [] } }]), envelope([{ functionCall: { name: 'search', id: 'x' } }, { functionCall: { name: 'search', id: 'x' } }]), envelope([{ thought: true }]), envelope([{ thoughtSignature: '' }]), envelope(parts, 'STOP', { promptFeedback: { blockReason: 'SAFETY' } }), envelope(parts, 'STOP', { usageMetadata: { ...usageMetadata, thoughtsTokenCount: -1 } }), envelope(parts, 'STOP', { usageMetadata: { ...usageMetadata, totalTokenCount: 11 } })]) await assert.rejects(jsonReply(body), { code: 'ENVELOPE' });
  const partial = { ...metadata, candidates: [{ content: { parts: [{ text: 'preview' }] } }] };
  for (const frames of [[partial], [partial, envelope([], 'STOP', { responseId: 'other' })], [partial, envelope([], 'STOP', { modelVersion: 'other' })]]) {
    await assert.rejects(makeProvider(() => stream(frames)).complete({ ...request, stream: true }), { code: 'ENVELOPE' });
  }
  await assert.rejects(makeProvider(() => stream([{ error: { code: 503, message: 'private upstream error' } }])).complete({ ...request, stream: true }), { code: 'HTTP' });
});

test('Gemini reports bounded response and stream diagnostics on the rejection and failed attempt', async () => {
  const privateText = 'private-upstream-value';
  const terminal = envelope([{ text: privateText, thoughtSignature: privateText }]);
  const partial = { ...metadata, candidates: [{ content: { parts: [{ text: privateText }] } }] };
  const cases = [
    ['invalid-response-id', { ...terminal, responseId: '' }],
    ['invalid-response-id', { ...terminal, responseId: { privateText } }],
    ['invalid-model', { ...terminal, modelVersion: '' }],
    ['invalid-model', { ...terminal, modelVersion: null }],
    ['invalid-candidate', { ...terminal, candidates: [{ index: privateText }] }],
    ['invalid-part', envelope([{ text: privateText, unsupportedField: privateText }])],
    ['invalid-part', envelope([{ functionCall: { name: 'search', partialArgs: privateText } }])],
    ['invalid-usage', { ...terminal, usageMetadata: { promptTokenCount: privateText } }],
    ['missing-terminal', partial],
  ];
  async function check(response, phase, reason) {
    const attempts = [];
    const diagnostic = { protocol: 'gemini-generate-content', phase, reason };
    await assert.rejects(makeProvider(() => response).complete({ ...request, stream: phase === 'stream' }, { attempt: (event) => attempts.push(event) }), (error) => {
      assert.equal(error.code, 'ENVELOPE');
      assert.deepEqual(error.diagnostic, diagnostic);
      assert.equal(error.cause, undefined);
      assert.ok(!error.message.includes(privateText));
      assert.ok(!JSON.stringify(error).includes(privateText));
      return true;
    });
    assert.deepEqual(attempts, [
      { kind: 'started', attempt: 1 },
      { kind: 'failed', attempt: 1, failure: { code: 'ENVELOPE', phase, diagnostic } },
    ]);
  }
  for (const [reason, body] of cases) {
    await check(Response.json(body), 'response', reason);
    await check(stream([body]), 'stream', reason);
  }
  await check(Response.json(metadata), 'response', 'invalid-candidate');
  await check(stream([partial, { ...terminal, responseId: privateText }]), 'stream', 'inconsistent-stream-identity');
  await check(stream([terminal, partial]), 'stream', 'event-order');
});

test('Gemini validates offline part order, call identity, omitted arguments and required signed material', async () => {
  const expected = await jsonReply(envelope(parts));
  for (const change of [
    (reply) => {
      reply.native.idSource = 'local';
    },
    (reply) => {
      reply.native.modelSource = 'configured';
    },
    (reply) => delete reply.native.partsSha256,
    (reply) => {
      reply.native.parts[2].thoughtSignature = 'different';
    },
    (reply) => reply.native.parts.splice(2, 1),
    (reply) => reply.native.parts.reverse(),
    (reply) => {
      reply.native.parts[1].wireId = 'fake';
    },
    (reply) => {
      reply.native.parts[2].omittedArgs = true;
    },
    (reply) => {
      reply.output[1].id = 'fake';
    },
    (reply) => {
      reply.native.promptBlocked = true;
    },
  ]) {
    const copy = structuredClone(expected);
    change(copy);
    assert.throws(() => requireModelReply(copy));
  }
});
