import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { AnthropicMessagesProvider, ChatCompletionsProvider, assertModelContinuation, modelReplyUsage } from '@weiliang0121/capix-model-provider';

// Hand-built offline samples from the Messages create and streaming event schemas.
// https://platform.claude.com/docs/en/api/messages/create
// https://platform.claude.com/docs/en/build-with-claude/streaming
const configuration = { model: 'model-alias', endpoint: 'https://messages.example/v1/messages', apiKey: 'offline-key', bindingId: 'fixture-account', anthropicVersion: '2023-06-01', maxTokens: 4096 };
const request = {
  messages: [
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: '查询' },
  ],
  tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
  toolChoice: 'auto',
  maxTokens: 2048,
};
const content = [
  { type: 'thinking', thinking: '查', signature: 'sig+==' },
  { type: 'text', text: '先查' },
  { type: 'tool_use', name: 'lookup', id: 'first', input: { city: '北京' } },
  { type: 'redacted_thinking', data: 'opaque' },
  { type: 'text', text: '再查' },
  { type: 'tool_use', name: 'lookup', id: 'second', input: {} },
];
const usage = { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, output_tokens: 7 };
const toolReply = { type: 'message', role: 'assistant', id: 'message-1', model: 'model-snapshot', stop_reason: 'tool_use', content, usage };
const answer = { ...toolReply, id: 'message-2', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }], usage: undefined };
const model = (fetch, options = {}) => new AnthropicMessagesProvider({ ...configuration, fetch, ...options });

function events(reply) {
  const result = [{ type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: reply.usage && { ...reply.usage, output_tokens: 1 } } }, { type: 'ping' }];
  for (const [index, block] of reply.content.entries()) {
    let start = block;
    let deltas = [];
    if (block.type === 'thinking') {
      start = { type: 'thinking', thinking: '' };
      deltas = [
        { type: 'thinking_delta', thinking: block.thinking },
        { type: 'signature_delta', signature: 'sig' },
        { type: 'signature_delta', signature: '+==' },
      ];
    } else if (block.type === 'text') {
      start = { type: 'text', text: '' };
      deltas = [{ type: 'text_delta', text: block.text }];
    } else if (block.type === 'tool_use') {
      start = { ...block, input: {} };
      const json = JSON.stringify(block.input);
      deltas = [
        { type: 'input_json_delta', partial_json: json.slice(0, 1) },
        { type: 'input_json_delta', partial_json: json.slice(1) },
      ];
    }
    result.push({ type: 'content_block_start', index, content_block: start }, ...deltas.map((delta) => ({ type: 'content_block_delta', index, delta })), { type: 'content_block_stop', index });
  }
  if (reply.usage) result.push({ type: 'message_delta', delta: {}, usage: { output_tokens: 4 } });
  result.push({ type: 'message_delta', delta: { stop_reason: reply.stop_reason }, usage: reply.usage && { output_tokens: reply.usage.output_tokens } }, { type: 'message_stop' });
  return result;
}

function sse(frames, { holdOpen = false, onCancel } = {}) {
  const bytes = Buffer.from(frames.map((frame) => `event: ${frame.type}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.subarray(offset, offset + 11));
          offset += 11;
        } else if (!holdOpen) controller.close();
      },
      cancel: onCancel,
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('Messages JSON and SSE preserve the same public output, signed replay, real feedback order and byte counts', async () => {
  const replies = [];
  for (const stream of [false, true]) {
    const sent = [];
    const provider = model(
      async (url, init) => {
        sent.push({ url, headers: new Headers(init.headers), body: init.body });
        const reply = sent.length === 1 ? toolReply : answer;
        return stream ? sse(events(reply), { holdOpen: true }) : Response.json(reply);
      },
      { thinkingBudgetTokens: 1024 },
    );
    const initial = { ...request, stream };
    const previews = [];
    const reasoning = [];
    const progress = [];
    const reply = await provider.complete(initial, { emit: (text) => previews.push(text), emitReasoning: (text) => reasoning.push(text), progress: ({ kind }) => progress.push(kind) });
    assert.deepEqual(reply.usage, { promptTokens: 20, completionTokens: 7, totalTokens: 27, promptCacheHitTokens: 3 });
    assert.deepEqual(previews, stream ? ['先查', '再查'] : []);
    assert.deepEqual(reasoning, stream ? ['查'] : []);
    assert.deepEqual(progress, stream ? ['reasoning', 'text', 'tool-call', 'text', 'tool-call'] : []);
    assert.ok(Object.isFrozen(reply.output[1].arguments.value));
    replies.push(reply);
    const feedback = ['second', 'first'].map((toolCallId) => ({ toolCallId, status: toolCallId === 'first' ? 'ok' : 'error', content: [{ kind: 'text', text: toolCallId + '"\\' }] }));
    const next = { ...initial, exchanges: [{ reply, feedback }] };
    const final = await provider.complete(next);
    assert.equal(final.usage, null);
    assert.deepEqual(final.output, [{ kind: 'text', text: '完成' }]);
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(sent[0].body), { model: 'model-alias', max_tokens: 2048, system: [{ type: 'text', text: 'Be brief' }], messages: [{ role: 'user', content: '查询' }], tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }], stream, tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 1024 } });
    assert.deepEqual(JSON.parse(sent[1].body).messages.slice(1), [
      { role: 'assistant', content },
      { role: 'user', content: feedback.toReversed().map(({ toolCallId, status, content }) => ({ type: 'tool_result', tool_use_id: toolCallId, is_error: status === 'error', content: [{ type: 'text', text: content[0].text }] })) },
    ]);
    for (const [index, material] of [initial, next].entries()) {
      assert.equal(sent[index].url, configuration.endpoint);
      assert.equal(sent[index].headers.get('x-api-key'), configuration.apiKey);
      assert.equal(sent[index].headers.get('anthropic-version'), configuration.anthropicVersion);
      assert.equal(sent[index].headers.get('authorization'), null);
      assert.equal(provider.inspectRequest(material).wireBytes, Buffer.byteLength(sent[index].body));
    }
    for (const override of [{ bindingId: 'other' }, { model: 'other' }, { anthropicVersion: '2024-01-01' }]) {
      assert.throws(() => model(assert.fail, override).inspectRequest(next), { code: 'REQUEST' });
    }
    assert.throws(() => new ChatCompletionsProvider(configuration).inspectRequest(next), { code: 'REQUEST' });
  }
  assert.deepEqual(replies[0], replies[1]);
});

test('Messages reports an unsupported JSON format before any attempt opens', async () => {
  const attempts = [];
  let sends = 0;
  const provider = model(async () => {
    sends++;
    return Response.json(answer);
  });
  const input = { ...request, responseFormat: 'json_object' };
  const diagnostic = { protocol: 'anthropic-messages', phase: 'request', reason: 'unsupported-response-format' };
  const verify = (error) => {
    assert.equal(error.code, 'REQUEST');
    assert.deepEqual(error.diagnostic, diagnostic);
    return true;
  };
  assert.throws(() => provider.inspectRequest(input), verify);
  await assert.rejects(provider.complete(input, { attempt: (event) => attempts.push(event) }), verify);
  assert.equal(sends, 0);
  assert.deepEqual(attempts, []);
});

test('Messages reports bounded JSON and SSE failure reasons on the rejection and failed attempt', async () => {
  const secret = 'upstream-private-material';
  // Two gateway shapes: empty final JSON signature, or streamed thinking deltas
  // followed by block_stop and visible text without an intervening signature.
  const unsigned = { ...answer, content: [{ type: 'thinking', thinking: secret, signature: '' }, ...answer.content] };
  const unsignedFrames = events(unsigned).filter((frame) => frame.delta?.type !== 'signature_delta');
  const blockStop = unsignedFrames.findIndex((frame) => frame.type === 'content_block_stop');
  unsignedFrames.splice(blockStop, 0, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'continued' } });
  const badOrder = events(unsigned);
  const thinking = badOrder.find((frame) => frame.delta?.type === 'thinking_delta');
  badOrder.splice(
    badOrder.findIndex((frame) => frame.type === 'content_block_stop'),
    0,
    thinking,
  );
  const unknown = { ...answer, content: [{ type: secret }] };
  const badBlock = { ...answer, content: [{ type: 'redacted_thinking', data: 5 }] };
  const badUsage = { ...answer, usage: { ...usage, input_tokens: secret } };
  for (const stream of [false, true]) {
    const phase = stream ? 'stream' : 'response';
    const cases = [
      [unsigned, 'missing-thinking-signature'],
      [unknown, 'unsupported-block'],
      [badBlock, 'invalid-block'],
      [badUsage, 'invalid-usage'],
      [{ ...answer, id: undefined }, 'missing-response-id'],
      [{ ...answer, id: 1 }, 'invalid-response-id'],
      [{ ...answer, model: undefined }, 'missing-model'],
      [{ ...answer, model: null }, 'invalid-model'],
    ];
    if (stream) cases.push([badOrder, 'event-order'], [[{ type: secret }], 'invalid-event']);
    for (const [sample, reason] of cases) {
      const attempts = [];
      const provider = model(
        async () => {
          if (!stream) return Response.json(sample);
          if (Array.isArray(sample)) return sse(sample);
          return sse(sample === unsigned ? unsignedFrames : events(sample));
        },
        { retry: { maxAttempts: 2, delayMs: 0 } },
      );
      const diagnostic = { protocol: 'anthropic-messages', phase, reason };
      await assert.rejects(provider.complete({ ...request, stream }, { attempt: (event) => attempts.push(event) }), (error) => {
        assert.equal(error.code, 'ENVELOPE');
        assert.deepEqual(error.diagnostic, diagnostic);
        assert.ok(Object.isFrozen(error.diagnostic));
        for (const marker of [secret, configuration.apiKey, configuration.endpoint, 'sig+==', '查询']) assert.ok(!inspect({ error, attempts }, { depth: null }).includes(marker));
        return true;
      });
      assert.deepEqual(attempts, [
        { kind: 'started', attempt: 1 },
        { kind: 'failed', attempt: 1, failure: { code: 'ENVELOPE', phase, diagnostic } },
      ]);
    }
  }
});

test('Messages rejects unsupported requests before sending, including thinking combinations', async () => {
  let sends = 0;
  const provider = model(() => sends++, { thinkingBudgetTokens: 1024 });
  for (const override of [{ messages: request.messages.toReversed() }, { messages: [request.messages[0]] }, { temperature: 1.5 }, { maxTokens: 1024 }, { temperature: 0 }, { toolChoice: 'required' }, { toolChoice: { name: 'lookup' } }, { messages: [...request.messages, { role: 'assistant', content: 'prefill' }] }]) {
    assert.throws(() => provider.inspectRequest({ ...request, ...override }), { code: 'REQUEST' });
    await assert.rejects(provider.complete({ ...request, ...override }), { code: 'REQUEST' });
  }
  for (const override of [{ thinkingBudgetTokens: 512 }, { thinkingBudgetTokens: 4096 }, { maxTokens: 0 }, { bindingId: ' ' }, { anthropicVersion: 'new\nvalue' }]) assert.throws(() => model(assert.fail, override), { code: 'CONFIGURATION' });
  assert.equal(sends, 0);
});

test('Messages validates finished blocks and usage and preserves incomplete and refused results', async () => {
  for (const override of [{ content: [{ type: 'server_tool_use' }] }, { content: [{ type: 'thinking', thinking: '' }] }, { content: [{ type: 'redacted_thinking', data: '' }] }, { content: [content[2], content[2]] }, { content: [{ ...content[2], input: [] }] }, { stop_reason: 'end_turn' }, { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } }, { usage: { input_tokens: 1, cache_read_input_tokens: -1 } }]) await assert.rejects(model(async () => Response.json({ ...toolReply, ...override })).complete(request), { code: 'ENVELOPE' });
  for (const [reason, kind] of [
    ['refusal', 'refused'],
    ['max_tokens', 'incomplete'],
    ['future_stop', 'incomplete'],
  ]) {
    const reply = await model(async () => Response.json({ ...answer, stop_reason: reason, usage: { input_tokens: 4 } })).complete(request);
    assert.deepEqual(reply.termination, { kind, reason });
    assert.equal(reply.usage, null);
  }
});

test('Messages retries premature EOF only with permission and rejects explicit errors and malformed events once', async () => {
  const frames = events(answer);
  const streaming = { ...request, stream: true };
  const retry = { maxAttempts: 2, delayMs: 0 };
  for (const [first, expected] of [
    [[{ type: 'error', error: { type: 'overloaded_error', message: 'private' } }], 'HTTP'],
    [[frames[0], { type: 'content_block_stop', index: 0 }], 'ENVELOPE'],
    [[frames[0], { type: 'content_block_start', index: 1, content_block: content[0] }], 'ENVELOPE'],
    [[frames[0], { type: 'content_block_start', index: 0, content_block: content[5] }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]' } }, { type: 'content_block_stop', index: 0 }], 'ENVELOPE'],
    [[...frames.slice(0, -2), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } }], 'ENVELOPE'],
  ]) {
    let sends = 0;
    await assert.rejects(
      model(
        async () => {
          sends++;
          return sse(first);
        },
        { retry },
      ).complete(streaming),
      { code: expected },
    );
    assert.equal(sends, 1);
  }
  for (const allow of [false, true]) {
    const attempts = [];
    let sends = 0;
    const completion = model(async () => sse(++sends === 1 ? frames.slice(0, -1) : frames), allow ? { retry } : {}).complete(streaming, { attempt: (event) => attempts.push(event.kind) });
    if (allow) {
      assert.equal((await completion).output[0].text, '完成');
      assert.deepEqual(attempts, ['started', 'failed', 'retrying', 'started', 'completed']);
    } else {
      await assert.rejects(completion, { code: 'ENVELOPE' });
      assert.deepEqual(attempts, ['started', 'failed']);
    }
  }
});

test('Messages releases the stream, honors byte limits and preserves cancellation and consumer failure identities', async () => {
  for (const mode of ['done', 'consumer', 'abort', 'bytes']) {
    const controller = new AbortController();
    const original = new Error(mode);
    let releases = 0;
    let sends = 0;
    const provider = model(
      async () => {
        sends++;
        return sse(events(answer), { holdOpen: true, onCancel: () => releases++ });
      },
      { retry: { maxAttempts: 2, delayMs: 0 }, maxResponseBytes: mode === 'bytes' ? 4 : 8192 },
    );
    const completion = provider.complete(
      { ...request, stream: true },
      {
        signal: controller.signal,
        emit() {
          if (mode === 'consumer') throw original;
          if (mode === 'abort') controller.abort(original);
        },
      },
    );
    if (mode === 'done') await completion;
    else if (mode === 'bytes') await assert.rejects(completion, { code: 'RESPONSE_LIMIT' });
    else await assert.rejects(completion, (failure) => failure === original);
    assert.equal(sends, 1);
    assert.equal(releases, 1);
  }
});

test('Messages JSON and SSE preserve final partial counters and expose only known common usage', async () => {
  for (const [wire, partial, known] of [
    [{ input_tokens: 12, output_tokens: 7 }, { input_tokens: 12, output_tokens: 7 }, { completionTokens: 7 }],
    [
      { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { promptTokens: 0, promptCacheHitTokens: 0 },
    ],
    [{ cache_creation_input_tokens: 5, output_tokens: null }, { cache_creation_input_tokens: 5 }, null],
    [
      { cache_read_input_tokens: 0, output_tokens: 0 },
      { cache_read_input_tokens: 0, output_tokens: 0 },
      { promptCacheHitTokens: 0, completionTokens: 0 },
    ],
    [{ input_tokens: null, service_tier: 'standard' }, undefined, null],
    [usage, undefined, { promptTokens: 20, promptCacheHitTokens: 3, completionTokens: 7, totalTokens: 27 }],
  ]) {
    for (const stream of [false, true]) {
      const frames = events(answer);
      frames[0].message.usage = { ...wire, output_tokens: 1 };
      frames.at(-2).usage = { output_tokens: wire.output_tokens };
      const attempts = [];
      const provider = model(async () => (stream ? sse(frames) : Response.json({ ...answer, usage: wire })));
      const reply = await provider.complete({ ...request, stream }, { attempt: (event) => attempts.push(event) });
      assert.deepEqual(reply.native.partialUsage, partial);
      assert.deepEqual(modelReplyUsage(reply), known);
      assert.deepEqual(reply.usage, known?.totalTokens === undefined ? null : known);
      assert.deepEqual(attempts.at(-1), { kind: 'completed', attempt: 1, usage: reply.usage });
    }
  }
});

test('nullable cumulative counters preserve observations and missing counts never become zero', async () => {
  const counters = { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let reply = await model(async () => Response.json({ ...answer, usage: counters })).complete(request);
  assert.deepEqual(reply.usage, { promptTokens: 12, completionTokens: 7, totalTokens: 19, promptCacheHitTokens: 0 });
  for (const absent of [null, undefined]) {
    reply = await model(async () => Response.json({ ...answer, usage: { ...counters, cache_creation_input_tokens: absent } })).complete(request);
    assert.equal(reply.usage, null);
  }
  const frames = events({ ...answer, usage });
  const stop = frames.at(-2);
  stop.usage = { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: 8 };
  reply = await model(async () => sse(frames)).complete({ ...request, stream: true });
  assert.deepEqual(reply.usage, { promptTokens: 20, completionTokens: 8, totalTokens: 28, promptCacheHitTokens: 3 });
  const onlyInitialUsage = frames.filter((frame) => frame.type !== 'message_delta' || frame.delta.stop_reason);
  delete stop.usage;
  reply = await model(async () => sse(onlyInitialUsage)).complete({ ...request, stream: true });
  assert.equal(reply.usage, null);
});

test('Messages admits default direct callers and empty citations, and requires final signatures', async () => {
  for (const stream of [false, true]) {
    const complete = (wire) => model(async () => (stream ? sse(events(wire)) : Response.json(wire))).complete({ ...request, stream });
    const text = { ...content[1], citations: [] };
    const call = { ...content[2], caller: { type: 'direct' }, toolset_name: null };
    const accepted = await complete({ ...toolReply, content: [text, call] });
    assert.equal(accepted.output[1].id, call.id);
    for (const block of [
      { ...call, caller: { type: 'code_execution_20250825', tool_id: 'server-call' } },
      { ...call, toolset_name: 'external-toolset' },
    ])
      await assert.rejects(complete({ ...toolReply, content: [block] }), { code: 'ENVELOPE' });
  }
  const frames = events(toolReply);
  frames.find((frame) => frame.content_block?.type === 'thinking').content_block.signature = '';
  const accepted = await model(async () => sse(frames)).complete({ ...request, stream: true });
  assert.equal(accepted.native.blocks[0].signature, 'sig+==');
  const unsigned = frames.filter((frame) => frame.delta?.type !== 'signature_delta');
  await assert.rejects(model(async () => sse(unsigned)).complete({ ...request, stream: true }), { code: 'ENVELOPE' });
  const unsignedJson = {
    ...toolReply,
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'intermediate', signature: '' },
      { type: 'text', text: 'answer' },
    ],
  };
  await assert.rejects(model(async () => Response.json(unsignedJson)).complete(request), { code: 'ENVELOPE' });
});

test('signed history fixes the system, tools and each preceding message while allowing new feedback', async () => {
  let sends = 0;
  const provider = model(async () => {
    sends++;
    return Response.json(toolReply);
  });
  const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
  const initial = { ...request, tools: [{ ...request.tools[0], parameters: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'string' } } } }], messages: [request.messages[0], { role: 'user', content: [image, { kind: 'text', text: '查询' }] }] };
  const first = await provider.complete(initial);
  assert.match(first.native.prefixSha256, /^[a-f0-9]{64}$/u);
  const feedback = ['first', 'second'].map((toolCallId) => ({ toolCallId, status: 'ok', content: [image] }));
  const next = { ...initial, exchanges: [{ reply: first, feedback }] };
  const second = await provider.complete(next);
  assert.notEqual(first.native.prefixSha256, second.native.prefixSha256);
  const last = { ...initial, exchanges: [...next.exchanges, { reply: second, feedback }] };
  for (const change of [(r) => (r.messages[0].content += '!'), (r) => r.messages[1].content.reverse(), (r) => (r.tools[0].description += '!'), (r) => (r.tools[0].parameters.properties.a.type = 'number'), (r) => (r.exchanges[0].feedback[1].content = [{ kind: 'text', text: 'image omitted' }]), (r) => (r.exchanges[0].reply.native.prefixSha256 = second.native.prefixSha256), (r) => (r.exchanges[1].reply.output[0].text += '!'), (r) => (r.exchanges[1].reply.native.blocks[0].signature += '!')]) {
    const changed = structuredClone(last);
    change(changed);
    assert.throws(() => assertModelContinuation(changed), { code: 'REQUEST' });
    assert.throws(() => provider.inspectRequest(changed), { code: 'REQUEST' });
    await assert.rejects(provider.complete(changed), { code: 'REQUEST' });
  }
  assert.equal(sends, 2);
  const reordered = structuredClone(last);
  reordered.tools[0].parameters.properties = Object.fromEntries(Object.entries(reordered.tools[0].parameters.properties).reverse());
  assert.doesNotThrow(() => provider.inspectRequest(reordered));
  const reservation = { feedback: [], contextGrowthBytes: 0 };
  assert.doesNotThrow(() => assertModelContinuation(last, reservation));
  assert.throws(() => assertModelContinuation(last, { ...reservation, mutableContext: true }), { code: 'REQUEST' });
  assert.throws(() => assertModelContinuation(last, { ...reservation, imageOmissionBytes: 1, imageOmissionByExchange: [1, 0] }), { code: 'REQUEST' });
  assert.doesNotThrow(() => assertModelContinuation(last, { ...reservation, imageOmissionBytes: 1, imageOmissionByExchange: [0, 1] }));
  assert.throws(() => assertModelContinuation(last, { ...reservation, imageOmissionBytes: 1, imageOmissionByExchange: [] }), /Invalid per-exchange/);
  assert.doesNotThrow(() => provider.reserveWireBytes(next, { ...reservation, imageOmissionBytes: 1 }));
  assert.throws(() => provider.reserveWireBytes(next, { ...reservation, contextGrowthBytes: 1 }), { code: 'REQUEST' });
  assert.throws(() => provider.reserveWireBytes(next, { ...reservation, mutableContext: true }), { code: 'REQUEST' });
  assert.throws(() => provider.reserveWireBytes(last, { ...reservation, imageOmissionBytes: 1 }), { code: 'REQUEST' });
  assert.doesNotThrow(() => provider.reserveWireBytes(last, { ...reservation, imageOmissionBytes: 1, imageOmissionByExchange: [0, 1] }));
});

test('manual thinking cannot start in the middle of an unsigned tool turn', async () => {
  const reply = await model(async () => Response.json({ ...toolReply, content: [content[2]] })).complete(request);
  const next = { ...request, exchanges: [{ reply, feedback: [{ toolCallId: 'first', status: 'ok', content: [{ kind: 'text', text: 'done' }] }] }] };
  assert.equal(reply.native.prefixSha256, undefined);
  assert.doesNotThrow(() => model(assert.fail).inspectRequest(next));
  assert.throws(() => model(assert.fail, { thinkingBudgetTokens: 1024 }).inspectRequest(next), { code: 'REQUEST' });
});

test('a manual-thinking turn can call another tool after feedback without an interleaved thinking block', async () => {
  const tool = content[2];
  const replies = [[content[0], tool], [{ ...tool, id: 'next' }], answer.content];
  const provider = model(
    async () => {
      const blocks = replies.shift();
      return Response.json({ ...toolReply, content: blocks, stop_reason: replies.length ? 'tool_use' : 'end_turn' });
    },
    { thinkingBudgetTokens: 1024 },
  );
  const exchanges = [];
  for (const toolCallId of ['first', 'next']) {
    const reply = await provider.complete({ ...request, exchanges });
    exchanges.push({ reply, feedback: [{ toolCallId, status: 'ok', content: [{ kind: 'text', text: 'done' }] }] });
  }
  assert.deepEqual((await provider.complete({ ...request, exchanges })).output, [{ kind: 'text', text: '完成' }]);
});

test('Messages preserves the stop reason across subsequent cumulative usage deltas', async () => {
  const frames = events({ ...answer, usage });
  frames.splice(-1, 0, { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } }, { type: 'message_delta', delta: { stop_reason: null }, usage: { cache_read_input_tokens: 4, output_tokens: null } });
  const complete = () => model(async () => sse(frames)).complete({ ...request, stream: true });
  const reply = await complete();
  assert.deepEqual(reply.termination, { kind: 'completed', reason: 'end_turn' });
  assert.deepEqual(reply.usage, { promptTokens: 21, completionTokens: 9, totalTokens: 30, promptCacheHitTokens: 4 });
  frames.splice(-1, 0, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
  await assert.rejects(complete(), { code: 'ENVELOPE' });
});

test('Messages returns the finished blocks when max_tokens cuts off the final streamed tool input', async () => {
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
  const frames = events({ ...toolReply, stop_reason: 'max_tokens' });
  const lastFragment = frames.findLast((frame) => frame.delta?.type === 'input_json_delta');
  lastFragment.delta.partial_json = '"city":"北';
  const complete = (sample) => model(async () => sse(sample)).complete({ ...request, stream: true });
  const reply = await complete(frames);
  const finished = await model(async () => Response.json({ ...toolReply, stop_reason: 'max_tokens', content: content.slice(0, -1) })).complete(request);
  assert.deepEqual(reply, finished);
  assert.deepEqual(reply.termination, { kind: 'incomplete', reason: 'max_tokens' });
  assert.deepEqual(
    reply.output.filter((item) => item.kind === 'tool-call').map((item) => item.id),
    ['first'],
  );
  const history = { ...request, exchanges: [{ reply, feedback: [{ toolCallId: 'first', status: 'ok', content: [{ kind: 'text', text: 'done' }] }] }] };
  assert.throws(() => assertModelContinuation(history));
  assert.throws(() => model(assert.fail).inspectRequest(history), { code: 'REQUEST' });
  await assert.rejects(complete(frames.filter((frame) => frame.delta?.type !== 'signature_delta')), { code: 'ENVELOPE' });
  await assert.rejects(complete(frames.slice(0, -1)), { code: 'ENVELOPE' });
  for (const input of ['{"city":"北', [], null]) {
    const malformed = { ...toolReply, stop_reason: 'max_tokens', content: [...content.slice(0, -1), { ...content.at(-1), input }] };
    await assert.rejects(model(async () => Response.json(malformed)).complete(request), { code: 'ENVELOPE' });
  }
  const laterBlock = frames.findIndex((frame) => frame.type === 'message_delta');
  await assert.rejects(complete([...frames.slice(0, laterBlock), { type: 'content_block_start', index: content.length, content_block: content[1] }, { type: 'content_block_stop', index: content.length }, ...frames.slice(laterBlock)]), { code: 'ENVELOPE' });
  for (const reason of ['tool_use', 'end_turn', 'refusal', 'pause_turn']) {
    frames.at(-2).delta.stop_reason = reason;
    await assert.rejects(complete(frames), { code: 'ENVELOPE' });
  }
});
