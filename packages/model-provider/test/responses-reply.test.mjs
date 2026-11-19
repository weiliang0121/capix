import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAIResponsesProvider } from '@weiliang0121/capix-model-provider';

const request = { messages: [{ role: 'user', content: 'Lookup' }] };
const reasoning = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }], content: [{ type: 'reasoning_text', text: 'detail' }], encrypted_content: 'opaque' };
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: '查询', annotations: [] }] };
const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: ' {bad JSON', status: 'completed' };
const response = { object: 'response', id: 'resp_1', model: 'served-model', status: 'completed', error: null, store: false, previous_response_id: null, incomplete_details: null, output: [reasoning, message, call], usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } };

function provider(fetch, options) {
  return new OpenAIResponsesProvider({ endpoint: 'https://offline.invalid/v1/responses', apiKey: 'key', model: 'model-alias', bindingId: 'fixture', fetch, ...options });
}

function events(final = response) {
  const starting = { ...response, output: [], status: 'in_progress', usage: null };
  const rs = { output_index: 0, item_id: reasoning.id };
  const msg = { output_index: 1, item_id: message.id, content_index: 0 };
  const fc = { output_index: 2, item_id: call.id };
  return [
    { type: 'response.created', response: starting },
    { type: 'response.in_progress', response: starting },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [], content: [], encrypted_content: 'partial' } },
    { type: 'response.reasoning_summary_part.added', ...rs, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', ...rs, summary_index: 0, delta: 'plan' },
    { type: 'response.reasoning_summary_text.done', ...rs, summary_index: 0, text: 'plan' },
    { type: 'response.reasoning_summary_part.done', ...rs, summary_index: 0, part: reasoning.summary[0] },
    { type: 'response.reasoning_text.delta', ...rs, content_index: 0, delta: 'detail' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', ...msg, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', ...msg, delta: '查' },
    { type: 'response.output_text.delta', ...msg, delta: '询' },
    { type: 'response.output_text.done', ...msg, text: '查询' },
    { type: 'response.content_part.done', ...msg, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', ...fc, delta: call.arguments },
    { type: 'response.function_call_arguments.done', ...fc, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 2, item: call },
    { type: 'response.' + final.status, response: final },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

function stream(sequence) {
  const raw = Buffer.from(sequence.map((event) => 'event: ' + event.type + '\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  const split = raw.indexOf(Buffer.from('查')) + 1;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(raw.subarray(0, split));
      controller.enqueue(raw.subarray(split));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Responses JSON and fragmented SSE preserve ordered reasoning, phase, item and call IDs and exact arguments', async () => {
  const json = await provider(() => Response.json(response)).complete(request);
  const text = [];
  const thoughts = [];
  const kinds = [];
  const final = structuredClone(response);
  delete final.output[0].encrypted_content;
  const sse = await provider(() => stream(events(final))).complete({ ...request, stream: true }, { emit: (s) => text.push(s), emitReasoning: (s) => thoughts.push(s), progress: ({ kind }) => kinds.push(kind) });
  assert.deepEqual(sse, json);
  assert.deepEqual(text, ['查', '询']);
  assert.deepEqual(thoughts, ['plan', 'detail']);
  assert.deepEqual(kinds, ['reasoning', 'text', 'tool-call']);
  assert.deepEqual(json.output, [
    { kind: 'text', text: '查询' },
    { kind: 'tool-call', id: 'call_1', name: 'lookup', arguments: { encoding: 'json-text', text: call.arguments } },
  ]);
  assert.deepEqual(json.native.items, [
    { kind: 'reasoning', id: 'rs_1', summary: ['plan'], content: ['detail'], encryptedContent: 'opaque' },
    { kind: 'message', id: 'msg_1', status: 'completed', phase: 'commentary', content: [{ kind: 'output_text', index: 0 }] },
    { kind: 'function_call', id: 'fc_1', status: 'completed', index: 1 },
  ]);
  assert.deepEqual(json.usage, { promptTokens: 7, completionTokens: 5, totalTokens: 12, promptCacheHitTokens: 4 });
  assert.ok(Object.isFrozen(json.native.items[0].summary));
});

test('Responses retains refusal and truncation as distinct terminal outcomes', async () => {
  const refusal = { ...response, output: [{ ...message, phase: 'final_answer', content: [{ type: 'refusal', refusal: 'declined' }] }], usage: null };
  const refused = await provider(() => Response.json(refusal)).complete(request);
  assert.deepEqual(refused.termination, { kind: 'refused', reason: 'refusal' });
  assert.deepEqual(refused.output, []);
  assert.deepEqual(refused.native.items[0].content, [{ kind: 'refusal', refusal: 'declined' }]);
  assert.equal(refused.usage, null);
  const final = { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  const interrupted = await provider(() => stream(events(final))).complete({ ...request, stream: true });
  assert.deepEqual(interrupted.termination, { kind: 'incomplete', reason: 'max_output_tokens' });
});

function completeSnapshots(index, done, terminal, status = 'completed') {
  const final = { ...response, status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, output: response.output.with(index, terminal) };
  const sequence = events(final).map((event) => (event.type === 'response.output_item.done' && event.output_index === index ? { ...event, item: done } : event));
  return provider(() => stream(sequence)).complete({ ...request, stream: true });
}

test('Responses reconciles equivalent JSON representations in done and terminal snapshots', async () => {
  const plain = { type: 'message', id: message.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '查询' }] };
  const defaults = { ...plain, phase: null, content: [{ ...plain.content[0], annotations: [], logprobs: [] }] };
  const direct = { ...call, async: false, namespace: null, caller: { type: 'direct' } };
  for (const [index, left, right] of [
    [1, plain, defaults],
    [2, call, direct],
  ]) {
    for (const status of ['completed', 'incomplete']) {
      const json = await provider(() => Response.json({ ...response, status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, output: response.output.with(index, left) })).complete(request);
      assert.deepEqual(await completeSnapshots(index, left, right, status), json);
      assert.deepEqual(await completeSnapshots(index, right, left, status), json);
    }
  }
});

test('Responses rejects contradictory material or invalid metadata in either snapshot', async () => {
  for (const [index, valid, other] of [
    [1, message, { ...message, phase: 'final_answer' }],
    [1, message, { ...message, content: [{ ...message.content[0], logprobs: [1] }] }],
    [1, message, { ...message, content: [{ ...message.content[0], annotations: [{ type: 'url_citation' }] }] }],
    [1, message, { ...message, content: [{ ...message.content[0], extra: true }] }],
    [2, call, { ...call, caller: { type: 'direct', extra: true } }],
    [2, call, { ...call, async: true }],
    [2, call, { ...call, namespace: 'server' }],
    [2, call, { ...call, status: 'incomplete' }],
    [0, reasoning, { ...reasoning, encrypted_content: 'different' }],
  ]) {
    await assert.rejects(completeSnapshots(index, valid, other), { code: 'ENVELOPE' });
    await assert.rejects(completeSnapshots(index, other, valid), { code: 'ENVELOPE' });
  }
  // Both statuses are valid in an incomplete response, but the two snapshots must agree.
  await assert.rejects(completeSnapshots(2, call, { ...call, status: 'incomplete' }, 'incomplete'), { code: 'ENVELOPE' });
  await assert.rejects(completeSnapshots(0, reasoning, { ...reasoning, status: 'completed' }), { code: 'ENVELOPE' });
  await assert.rejects(completeSnapshots(0, { ...reasoning, encrypted_content: null }, reasoning), { code: 'ENVELOPE' });
});

test('Responses rejects unsupported material, contradictory statuses, identifiers and counters', async () => {
  for (const [fields, reason] of [
    [{ store: true }, 'store-mismatch'],
    [{ previous_response_id: 'unrelated' }, 'predecessor-mismatch'],
  ]) {
    const result = provider(() => Response.json({ ...response, ...fields })).complete(request);
    await assert.rejects(result, { code: 'ENVELOPE', diagnostic: { protocol: 'openai-responses', phase: 'response', reason } });
  }
  for (const invalid of [{ output: [{ type: 'web_search_call', id: 'ws' }] }, { output: [{ ...reasoning, summary: [{ type: 'unknown', text: 'secret' }] }] }, { output: [{ ...reasoning, extra: 7 }] }, { output: [{ ...message, content: [{ type: 'output_text', text: 'cited', annotations: [{ type: 'url_citation' }] }] }] }, { output: [{ ...call, namespace: 'ns' }] }, { output: [{ ...call, caller: { type: 'program' } }] }, { output: [{ ...call, status: 'in_progress' }] }, { output: [reasoning, reasoning] }, { output: [call, { ...call, id: 'fc_2' }] }, { status: 'queued' }, { status: 'incomplete' }, { usage: { ...response.usage, total_tokens: 11 } }, { usage: { ...response.usage, input_tokens_details: { cached_tokens: -1 } } }, { usage: { ...response.usage, output_tokens_details: { reasoning_tokens: 6 } } }]) {
    await assert.rejects(provider(() => Response.json({ ...response, ...invalid })).complete(request), { code: 'ENVELOPE' });
  }
});

test('Responses SSE rejects truncation, wrong item identity, reordered deltas, conflicting final material and explicit errors', async () => {
  const streaming = { ...request, stream: true };
  for (const mutate of [(s) => s.slice(0, -1), (s) => s.map((e) => (e.type === 'response.output_text.delta' ? { ...e, item_id: 'wrong' } : e)), (s) => s.map((e) => (e.type === 'response.output_text.done' ? { ...e, text: 'other' } : e)), (s) => s.map((e) => (e.type === 'response.function_call_arguments.delta' ? { ...e, sequence_number: 0 } : e)), (s) => s.map((e) => (e.type === 'response.function_call_arguments.delta' ? { ...e, type: 'response.custom_tool_call_input.delta' } : e)), (s) => s.map((e) => (e.type === 'response.completed' ? { ...e, response: { ...e.response, output: [reasoning, message, { ...call, arguments: 'switched' }] } } : e))]) {
    await assert.rejects(provider(() => stream(mutate(events()))).complete(streaming), { code: 'ENVELOPE' });
  }
  for (const type of ['error', 'response.failed']) {
    let attempts = 0;
    await assert.rejects(
      provider(
        () => {
          attempts++;
          return stream([{ type, sequence_number: 0 }]);
        },
        { retry: { maxAttempts: 2, delayMs: 0 } },
      ).complete(streaming),
      { code: 'HTTP' },
    );
    assert.equal(attempts, 1);
  }
});

test('Responses SSE enforces the transport limit and preserves consumer cancellation', async () => {
  const streaming = { ...request, stream: true };
  await assert.rejects(provider(() => stream(events()), { maxResponseBytes: 64 }).complete(streaming), { code: 'RESPONSE_LIMIT' });
  const signal = new AbortController();
  const reason = new Error('stop preview');
  await assert.rejects(provider(() => stream(events())).complete(streaming, { signal: signal.signal, emit: () => signal.abort(reason) }), (error) => error === reason);
});

test('a finished function item waits for the terminal response, which closes a still-open HTTP stream', async () => {
  const sequence = events();
  const final = sequence.pop();
  let controller;
  let cleaned = false;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      cleaned = true;
    },
  });
  const append = (event) => controller.enqueue(Buffer.from('data: ' + JSON.stringify(event) + '\n\n'));
  const preview = Promise.withResolvers();
  let settled = false;
  const operation = provider(() => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
    .complete(
      { ...request, stream: true },
      {
        progress: ({ kind }) => {
          if (kind === 'tool-call') preview.resolve();
        },
      },
    )
    .then((result) => {
      settled = true;
      return result;
    });
  sequence.forEach(append);
  await preview.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(cleaned, false);
  append(final);
  const result = await operation;
  assert.equal(result.output.at(-1).id, 'call_1');
  assert.equal(cleaned, true);
});

test('Responses checks the source of streamed previews and the name on argument completion', async () => {
  const streaming = { ...request, stream: true };
  for (const [type, change, forbidden] of [
    ['message', { role: 'user' }, 'text'],
    ['function_call', { caller: { type: 'program' } }, 'tool-call'],
    ['function_call', { async: true }, 'tool-call'],
    ['function_call', { namespace: 'server' }, 'tool-call'],
  ]) {
    const sequence = events().map((event) => (event.type === 'response.output_item.added' && event.item.type === type ? { ...event, item: { ...event.item, ...change } } : event));
    const activity = [];
    await assert.rejects(provider(() => stream(sequence)).complete(streaming, { emit: () => activity.push('text'), progress: ({ kind }) => activity.push(kind) }), { code: 'ENVELOPE' });
    assert.ok(!activity.includes(forbidden));
  }
  for (const name of ['another', call.name]) {
    const sequence = events().map((event) => (event.type === 'response.function_call_arguments.done' ? { ...event, name } : event));
    const operation = provider(() => stream(sequence)).complete(streaming);
    if (name !== call.name) await assert.rejects(operation, { code: 'ENVELOPE' });
    else assert.equal((await operation).output.at(-1).arguments.text, call.arguments);
  }
});

test('Responses accepts output-only created_by from JSON and SSE and omits it from manual replay', async () => {
  const returned = { ...response, output: response.output.map((item) => ({ ...item, created_by: response.id })) };
  const json = await provider(() => Response.json(returned)).complete(request);
  const sequence = events(returned).map((event) => (event.type === 'response.output_item.added' ? { ...event, item: { ...event.item, created_by: response.id } } : event));
  const sse = await provider(() => stream(sequence)).complete({ ...request, stream: true });
  assert.deepEqual(sse, json);
  const feedback = [{ toolCallId: call.call_id, status: 'error', content: [{ kind: 'text', text: 'invalid input' }] }];
  let input;
  await provider((_url, init) => {
    input = JSON.parse(init.body).input;
    return Response.json({ ...response, id: 'resp_2', output: [] });
  }).complete({ ...request, exchanges: [{ reply: sse, feedback }] });
  assert.deepEqual(
    input.filter((item) => ['reasoning', 'message', 'function_call'].includes(item.type)),
    response.output,
  );
  for (const fetch of [() => Response.json({ ...response, output: [{ ...call, created_by: 42 }] }), () => stream(events().map((event) => (event.type === 'response.output_item.done' ? { ...event, item: { ...event.item, created_by: {} } } : event)))]) {
    const result = fetch();
    await assert.rejects(provider(() => result).complete({ ...request, stream: result.headers.get('content-type') === 'text/event-stream' }), { code: 'ENVELOPE' });
  }
});
