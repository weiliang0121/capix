import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertModelContinuation, OpenAIResponsesProvider, requireModelExchange, requireModelRequest } from '@weiliang0121/capix-model-provider';

const route = { endpoint: 'https://offline.example/v1/responses', model: 'configured', apiKey: 'offline-secret', bindingId: 'project-A' };
const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
const text = (value) => ({ kind: 'text', text: value });
const first = {
  messages: [
    { role: 'system', content: 'Instruction' },
    { role: 'user', content: [image, text('begin')] },
  ],
  tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
  toolChoice: 'required',
};
const message = { type: 'message', id: 'msg', status: 'completed', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'reading', annotations: [] }] };
const reasoning = { type: 'reasoning', id: 'rs', encrypted_content: 'sealed', summary: [{ type: 'summary_text', text: 'summary' }] };
const call = { type: 'function_call', id: 'fc_one', call_id: 'one', name: 'lookup', arguments: '{"value":"一"}', status: 'completed' };
const another = { ...call, id: 'fc_two', call_id: 'two', arguments: '{}' };
const output = [reasoning, message, call, another];
const feedback = [
  { toolCallId: 'two', status: 'error', content: [image, text('failure')] },
  { toolCallId: 'one', status: 'ok', content: [text('"\\\n')] },
];

function reply(id, items = output) {
  return { id, model: 'actual-snapshot', object: 'response', status: 'completed', output: items };
}

for (const continuation of ['replay', 'previous-response-id']) {
  test('Responses ' + continuation + ' encodes native input and ordered feedback across independent senders', async () => {
    const sent = [];
    const build = (options) =>
      new OpenAIResponsesProvider({
        ...route,
        ...(continuation === 'replay' ? {} : { continuation }),
        ...options,
        fetch: async (url, init) => {
          assert.equal(url, route.endpoint);
          assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-secret');
          sent.push(init.body);
          const items = sent.length === 1 ? output : output.map((item) => ({ ...item, id: item.id + sent.length, ...(item.type === 'function_call' ? { call_id: item.call_id + sent.length, name: 'fresh' } : {}) }));
          return Response.json(reply('resp_' + sent.length, items));
        },
      });
    let request = first;
    let previous = await build().complete(request);
    for (let round = 1; round <= 2; round++) {
      const results = round === 1 ? feedback : feedback.map((result) => ({ ...result, toolCallId: result.toolCallId + round }));
      request = { ...first, temperature: 0.5, responseFormat: 'json_object', maxTokens: 320, toolChoice: { name: 'fresh' }, tools: [{ ...first.tools[0], name: 'fresh' }], exchanges: [...(request.exchanges ?? []), { reply: previous, feedback: results }] };
      const provider = build();
      const inspection = provider.inspectRequest(request);
      previous = await provider.complete(request);
      assert.equal(inspection.requestBytes, Buffer.byteLength(JSON.stringify(request)));
      assert.equal(inspection.wireBytes, Buffer.byteLength(sent.at(-1)));
    }
    const [initial, second, third] = sent.map((body) => JSON.parse(body));
    const remote = continuation === 'previous-response-id';
    assert.equal(initial.store, remote);
    assert.equal(initial.previous_response_id, undefined);
    assert.deepEqual(initial.input[1].content, [
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AP/Z', detail: 'auto' },
      { type: 'input_text', text: 'begin' },
    ]);
    assert.deepEqual(initial.include, remote ? undefined : ['reasoning.encrypted_content']);
    for (const [round, body] of [second, third].entries()) {
      assert.equal(body.store, remote);
      assert.equal(body.previous_response_id, remote ? 'resp_' + (round + 1) : undefined);
      assert.deepEqual(body.tool_choice, { type: 'function', name: 'fresh' });
      assert.deepEqual(body.text, { format: { type: 'json_object' } });
      assert.equal(body.tools[0].strict, false);
      assert.equal(body.max_output_tokens, 320);
      assert.equal(body.temperature, 0.5);
      if (remote) assert.equal(body.input.length, 2);
      else assert.deepEqual(body.input.slice(2, 6), [reasoning, { ...message, content: [{ ...message.content[0], logprobs: [] }] }, call, another]);
      assert.deepEqual(
        body.input.slice(-2).map((item) => item.call_id),
        round === 0 ? ['one', 'two'] : ['one2', 'two2'],
      );
      assert.deepEqual(body.input.at(-1).output, [{ type: 'input_text', text: '{"status":"error"}' }, ...initial.input[1].content.slice(0, 1), { type: 'input_text', text: 'failure' }]);
    }
    const changed = { ...request, messages: [{ role: 'user', content: 'changed' }] };
    const changedFeedback = structuredClone(request);
    changedFeedback.exchanges[0].feedback[0].content[0] = text('removed');
    for (const alternative of [changed, changedFeedback]) {
      if (remote) assert.throws(() => assertModelContinuation(alternative), { code: 'REQUEST' });
      else assert.doesNotThrow(() => assertModelContinuation(alternative));
    }
    const reserve = (extra) => assertModelContinuation(request, { feedback: [], contextGrowthBytes: 0, ...extra });
    for (const growth of [{ mutableContext: true }, { imageOmissionBytes: 120, imageOmissionByExchange: [120, 0] }]) {
      if (remote) assert.throws(() => reserve(growth), { code: 'REQUEST' });
      else reserve(growth);
    }
    reserve({ imageOmissionBytes: 120, imageOmissionByExchange: [0, 120] });
    if (remote) assert.throws(() => assertModelContinuation({ ...request, exchanges: request.exchanges.slice(1) }), { code: 'REQUEST' });
    for (const options of [{ bindingId: 'project-B' }, { model: 'other' }, { continuation: remote ? 'replay' : 'previous-response-id' }]) assert.throws(() => build(options).inspectRequest(request), { code: 'REQUEST' });
    const tampered = structuredClone(request);
    tampered.exchanges[0].reply.id = 'resp_unrelated';
    assert.throws(() => assertModelContinuation(tampered), { code: 'REQUEST' });
  });
}

test('missing encrypted reasoning fails replay preflight before a second request', async () => {
  for (const item of [
    { ...reasoning, encrypted_content: null },
    { type: 'reasoning', id: 'rs', summary: [] },
  ]) {
    let sends = 0;
    const provider = new OpenAIResponsesProvider({
      ...route,
      fetch: async () => {
        sends++;
        return Response.json(reply('resp_one', [item, call]));
      },
    });
    const result = await provider.complete(first);
    const request = { ...first, exchanges: [{ reply: result, feedback: feedback.slice(1) }] };
    const expected = { code: 'REQUEST', diagnostic: { protocol: 'openai-responses', phase: 'request', reason: 'missing-reasoning-ciphertext' } };
    assert.throws(() => assertModelContinuation(request), expected);
    assert.throws(() => provider.inspectRequest(request), expected);
    await assert.rejects(provider.complete(request), expected);
    assert.equal(sends, 1);
  }
});

test('Responses wire reservation covers escaped text, many parts and compact native images', async () => {
  for (const continuation of ['replay', 'previous-response-id']) {
    const provider = new OpenAIResponsesProvider({ ...route, continuation, fetch: async () => Response.json(reply('resp_budget', [call])) });
    const result = await provider.complete(first);
    for (const textParts of [1, 15, 32]) {
      const placeholder = { toolCallId: 'one', status: 'ok', content: Array.from({ length: textParts }, () => text('')) };
      const project = (f) => ({ ...first, exchanges: [{ reply: result, feedback: [f] }] });
      for (const content of [Array(32).fill(text('')), Array(32).fill(image), [text('"用户\\\n'.repeat(40))], [text('a'), image, text(''), image]]) {
        const actual = { ...placeholder, status: 'error', content };
        const maxBytes = Math.max(Buffer.byteLength(JSON.stringify(actual)), Buffer.byteLength(JSON.stringify(placeholder)));
        const reserved = provider.reserveWireBytes(project(placeholder), { feedback: [{ toolCallId: 'one', maxBytes }], contextGrowthBytes: 0 });
        assert.ok(reserved >= provider.inspectRequest(project(actual)).wireBytes);
      }
    }
  }
});

test('Responses sends an exact wire budget and rejects a one-byte shortfall before fetch', async () => {
  let sends = 0;
  const make = (maxWireRequestBytes) =>
    new OpenAIResponsesProvider({
      ...route,
      maxWireRequestBytes,
      fetch: async () => {
        sends++;
        return Response.json(reply('resp_exact'));
      },
    });
  const bytes = make().inspectRequest(first).wireBytes;
  await make(bytes).complete(first);
  await assert.rejects(make(bytes - 1).complete(first), { code: 'REQUEST_LIMIT' });
  assert.equal(sends, 1);
});

test('Responses refuses conflicting storage and predecessor echoes', async () => {
  for (const continuation of ['replay', 'previous-response-id']) {
    const store = continuation === 'previous-response-id';
    const make = (fields) => new OpenAIResponsesProvider({ ...route, continuation, fetch: async () => Response.json({ ...reply('resp_echo'), ...fields }) });
    await assert.rejects(make({ store: !store }).complete(first), { code: 'ENVELOPE' });
    await assert.rejects(make({ previous_response_id: 'foreign' }).complete(first), { code: 'ENVELOPE' });
    if (store) {
      const initial = await make({ previous_response_id: null, store }).complete(first);
      await assert.rejects(make({ previous_response_id: null }).complete({ ...first, exchanges: [{ reply: initial, feedback }] }), { code: 'ENVELOPE' });
    }
  }
});

for (const continuation of ['replay', 'previous-response-id']) {
  test('Responses ' + continuation + ' checks a mutable trailing user string against its original prefix', async () => {
    const provider = new OpenAIResponsesProvider({ ...route, continuation, fetch: async () => Response.json(reply('resp_context')) });
    const initial = { ...first, messages: [...first.messages, { role: 'user', content: 'context' }] };
    const request = { ...initial, exchanges: [{ reply: await provider.complete(initial), feedback }] };
    const reservation = { feedback: [], mutableContext: true, contextShape: 'trailing-user-text', contextGrowthBytes: 0 };
    if (continuation === 'previous-response-id') assert.throws(() => provider.reserveWireBytes(request, reservation), { code: 'REQUEST' });
    else assert.equal(provider.reserveWireBytes(request, reservation), provider.inspectRequest(request).wireBytes);
  });

  test('Responses ' + continuation + ' checks distinct item and call identities across rounds before tool execution', async () => {
    for (const duplicate of ['item', 'call', 'none']) {
      // Different identity namespaces may intentionally use the same string.
      const nextCall = { ...call, id: duplicate === 'item' ? call.id : call.call_id, call_id: duplicate === 'call' ? call.call_id : 'resp_first' };
      const responses = [reply('resp_first', [call]), reply(call.id, [nextCall])];
      const provider = new OpenAIResponsesProvider({ ...route, continuation, fetch: async () => Response.json(responses.shift()) });
      const initial = await provider.complete(first);
      const exchanges = [{ reply: initial, feedback: feedback.slice(1) }];
      const next = await provider.complete({ ...first, exchanges });
      const placeholder = { toolCallId: nextCall.call_id, status: 'ok', content: [text('')] };
      const request = { ...first, exchanges: [...exchanges, { reply: next, feedback: [placeholder] }] };
      const reservation = { feedback: [{ toolCallId: nextCall.call_id, maxBytes: 128 }], contextGrowthBytes: 0 };
      const preflight = () => assertModelContinuation(request, reservation);
      if (duplicate === 'none') assert.doesNotThrow(preflight);
      else {
        assert.throws(preflight, { code: 'REQUEST' });
        assert.throws(() => provider.reserveWireBytes(request, reservation), { code: 'REQUEST' });
      }
      assert.equal(responses.length, 0);
    }
  });
}

test('a shared Provider derives the remote handle from each request when two sessions interleave', async () => {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const chains = new Map();
  const provider = new OpenAIResponsesProvider({
    endpoint: 'https://exchange.invalid/v1/responses',
    model: 'model',
    apiKey: 'offline',
    bindingId: 'gateway',
    continuation: 'previous-response-id',
    async fetch(_url, { body }) {
      const { input, previous_response_id: parent } = JSON.parse(body);
      const session = parent ? chains.get(parent) : input[0].content;
      assert.ok(['alpha', 'beta'].includes(session));
      if (!parent && session === 'alpha') {
        arrived.resolve();
        await release.promise;
      }
      const id = (parent ? 'next_' : 'resp_') + session;
      chains.set(id, session);
      if (parent) assert.equal(input[0].call_id, 'call_' + session);
      const output = parent ? [{ type: 'message', id: 'msg_' + session, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: session, annotations: [] }] }] : [{ type: 'function_call', id: 'fc_' + session, call_id: 'call_' + session, name: 'lookup', arguments: '{}', status: 'completed' }];
      return Response.json({ object: 'response', id, model: 'model', status: 'completed', previous_response_id: parent ?? null, output });
    },
  });
  const base = (session) => ({ messages: [{ role: 'user', content: session }], tools: [{ name: 'lookup', parameters: { type: 'object' }, description: 'look up session' }] });
  const firstAlpha = provider.complete(base('alpha'));
  await arrived.promise;
  let beta;
  try {
    beta = await provider.complete(base('beta'));
  } finally {
    release.resolve();
  }
  const alpha = await firstAlpha;
  const resume = (session, reply) => provider.complete({ ...base(session), exchanges: [{ reply, feedback: [{ toolCallId: 'call_' + session, status: 'ok', content: [{ kind: 'text', text: session }] }] }] });
  const results = await Promise.all([resume('beta', beta), resume('alpha', alpha)]);
  assert.deepEqual(
    results.map((reply) => reply.output[0].text),
    ['beta', 'alpha'],
  );
});

for (const continuation of ['replay', 'previous-response-id']) {
  test('Responses ' + continuation + ' detects an incomplete response relabeled as completed', async () => {
    const value = { ...reply('resp_incomplete', [call]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    const provider = new OpenAIResponsesProvider({ ...route, continuation, fetch: async () => Response.json(value) });
    const initial = await provider.complete(first);
    assert.deepEqual(initial.termination, { kind: 'incomplete', reason: 'max_output_tokens' });
    const exchange = requireModelExchange({ reply: { ...initial, termination: { kind: 'completed', reason: 'completed' } }, feedback: feedback.slice(1) });
    const request = { ...first, exchanges: [exchange] };
    assert.throws(() => assertModelContinuation(request), { code: 'REQUEST' });
    assert.throws(() => provider.inspectRequest(request), { code: 'REQUEST' });
  });
}

test('Responses accepts a 16-token output budget and rejects 15 before transport', async () => {
  const sent = [];
  const provider = new OpenAIResponsesProvider({
    ...route,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json(reply('resp_limit'));
    },
  });
  const below = requireModelRequest({ ...first, maxTokens: 15 });
  assert.throws(() => provider.inspectRequest(below), { code: 'REQUEST' });
  await assert.rejects(provider.complete(below), { code: 'REQUEST' });
  assert.equal(sent.length, 0);
  const minimum = { ...first, maxTokens: 16 };
  assert.doesNotThrow(() => provider.inspectRequest(minimum));
  await provider.complete(minimum);
  assert.deepEqual(
    sent.map((body) => body.max_output_tokens),
    [16],
  );
});
