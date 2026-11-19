import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { OpenAIResponsesProvider } from '@weiliang0121/capix-model-provider';
import { assembly, host, input, journal, member } from './fixture.mjs';

const route = { endpoint: 'https://gateway.invalid/v1/responses', model: 'local-model', bindingId: 'workspace-gateway', apiKey: 'offline' };
const functionCall = { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', status: 'completed', name: 'lookup', arguments: '{"key":"用户"}' };
const answer = { type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'found', annotations: [] }] };

function responseBody(body, first, output) {
  return { object: 'response', id: first ? 'resp_lookup' : 'resp_answer', model: route.model, status: 'completed', error: null, incomplete_details: null, store: body.store, previous_response_id: body.previous_response_id ?? null, output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
}

function generation(body, first, output = [first ? functionCall : answer]) {
  return Response.json(responseBody(body, first, output));
}

function scenario(continuation, run) {
  return { policyVersion: 'lookup-v1/' + continuation, tools: { lookup: member('lookup', run, true) }, checkpoint: true };
}

for (const continuation of ['replay', 'previous-response-id']) {
  test(`Responses ${continuation} runs the same Tool and cold-confirms the completed checkpoint offline`, async () => {
    const requests = [];
    const lookedUp = [];
    const provider = new OpenAIResponsesProvider({
      ...route,
      continuation,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        assert.ok(requests.length <= 2);
        return generation(body, requests.length === 1);
      },
    });
    const local = host((request) => provider.complete(request));
    const saves = journal();
    const scene = assembly(
      scenario(continuation, ({ key }) => {
        lookedUp.push(key);
        return { text: 'record ' + key };
      }),
      local,
      { inspection: provider, store: saves.store },
    );
    try {
      assert.equal(await scene.runner.run(input), 'found');
      assert.deepEqual(lookedUp, ['用户']);
      assert.equal(requests.length, 2);
      const [first, second] = requests;
      assert.equal(first.previous_response_id, undefined);
      assert.equal(second.store, continuation === 'previous-response-id');
      const feedback = second.input.filter((item) => item.type === 'function_call_output');
      assert.deepEqual(
        feedback.map((item) => item.call_id),
        [functionCall.call_id],
      );
      assert.match(JSON.stringify(feedback[0].output), /record 用户/);
      if (continuation === 'previous-response-id') {
        assert.equal(second.previous_response_id, 'resp_lookup');
        assert.deepEqual(second.input, feedback);
      } else {
        assert.equal(second.previous_response_id, undefined);
        assert.ok(second.input.some((item) => item.type === 'function_call' && item.call_id === functionCall.call_id));
        assert.equal(second.input[0].role, 'user');
      }
    } finally {
      await local.interactions.settled();
      local.interactions.close();
    }
    const snapshot = JSON.parse(JSON.stringify(scene.entity.snapshot()));
    for (const change of ['none', 'durable-response-id']) {
      const states = structuredClone(local.states);
      if (change === 'durable-response-id') {
        const first = [...states.values()].find((state) => state.feedback.payload.id === 'resp_lookup');
        first.feedback.payload.id = 'resp_other';
      }
      const cold = host(() => assert.fail('reissued a model request'), states);
      const restored = assembly(
        scenario(continuation, () => assert.fail('repeated a tool')),
        cold,
        { entity: ModelExchanges.restore(snapshot), store: saves.replay() },
      );
      try {
        if (change === 'none') assert.equal(await restored.runner.resume(saves.contextId), 'found');
        else await assert.rejects(restored.runner.resume(saves.contextId));
        assert.deepEqual(cold.sent, []);
        assert.deepEqual(restored.entity.snapshot(), snapshot);
      } finally {
        await cold.interactions.settled();
        cold.interactions.close();
      }
    }
  });
}

test('Responses delivers streamed text with explicit terminal defaults after one tool execution', async () => {
  const requests = [];
  const effects = [];
  const done = { type: 'message', id: answer.id, role: 'assistant', status: 'completed', content: answer.content };
  const terminal = { ...done, phase: null, content: [{ ...done.content[0], logprobs: [] }] };
  const provider = new OpenAIResponsesProvider({
    ...route,
    continuation: 'previous-response-id',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.ok(requests.length <= 2);
      assert.equal(body.stream, true);
      const first = requests.length === 1;
      const completed = responseBody(body, first, [first ? functionCall : terminal]);
      const starting = { ...completed, output: [], status: 'in_progress', usage: null };
      const call = { output_index: 0, item_id: functionCall.id };
      const text = { output_index: 0, item_id: done.id, content_index: 0 };
      const events = [
        { type: 'response.created', response: starting },
        { type: 'response.in_progress', response: starting },
        ...(first
          ? [
              { type: 'response.output_item.added', output_index: 0, item: { ...functionCall, arguments: '', status: 'in_progress' } },
              { type: 'response.function_call_arguments.delta', ...call, delta: functionCall.arguments },
              { type: 'response.function_call_arguments.done', ...call, arguments: functionCall.arguments },
            ]
          : [
              { type: 'response.output_item.added', output_index: 0, item: { ...done, content: [], status: 'in_progress' } },
              { type: 'response.content_part.added', ...text, part: { ...done.content[0], text: '' } },
              { type: 'response.output_text.delta', ...text, delta: done.content[0].text },
              { type: 'response.output_text.done', ...text, text: done.content[0].text },
              { type: 'response.content_part.done', ...text, part: done.content[0] },
            ]),
        { type: 'response.output_item.done', output_index: 0, item: first ? functionCall : done },
        { type: 'response.completed', response: completed },
      ];
      return new Response(events.map((event, sequence_number) => 'event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const local = host((request) => provider.complete(request));
  const lookup = member('lookup', ({ key }) => {
    effects.push(key);
    return { text: 'record ' + key };
  });
  const scene = assembly({ tools: { lookup }, policyVersion: 'stream-defaults' }, local, { inspection: provider });
  try {
    assert.equal(await scene.runner.run({ request: { ...input.request, stream: true } }), 'found');
    assert.deepEqual(effects, ['用户']);
    assert.deepEqual(
      requests.map((body) => body.previous_response_id),
      [undefined, 'resp_lookup'],
    );
    assert.deepEqual(requests[1].input, [
      {
        type: 'function_call_output',
        call_id: functionCall.call_id,
        output: [
          { type: 'input_text', text: '{"status":"ok"}' },
          { type: 'input_text', text: 'record 用户' },
        ],
      },
    ]);
    assert.equal(local.sent.length, 2);
    assert.deepEqual(
      [...local.states.values()].map((state) => state.feedback.payload.id),
      ['resp_lookup', 'resp_answer'],
    );
    assert.deepEqual(scene.entity.snapshot().entries[0].feedback, [{ toolCallId: functionCall.call_id, status: 'ok', content: [{ kind: 'text', text: 'record 用户' }] }]);
  } finally {
    await local.interactions.settled();
    local.interactions.close();
  }
});

test('Responses replay without encrypted reasoning rejects before dispatching tools or continuing', async () => {
  const posts = [];
  let executions = 0;
  const provider = new OpenAIResponsesProvider({
    ...route,
    continuation: 'replay',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ url, method: init.method, include: body.include });
      return generation(body, true, [{ type: 'reasoning', id: 'rs_lookup', summary: [{ type: 'summary_text', text: 'Read the record' }] }, functionCall]);
    },
  });
  const local = host((request) => provider.complete(request));
  const lookup = member('lookup', () => {
    executions++;
    return { text: 'record' };
  });
  const { runner, entity } = assembly({ tools: { lookup }, policyVersion: 'missing-encrypted-reasoning' }, local);
  try {
    await assert.rejects(runner.run(input), { code: 'REQUEST', diagnostic: { protocol: 'openai-responses', phase: 'request', reason: 'missing-reasoning-ciphertext' } });
    assert.deepEqual(posts, [{ url: route.endpoint, method: 'POST', include: ['reasoning.encrypted_content'] }]);
    assert.equal(local.sent.length, 1);
    assert.equal(executions, 0);
    const [entry] = entity.values();
    assert.equal(entry.reply.id, 'resp_lookup');
    assert.deepEqual(entry.feedback, []);
    assert.deepEqual(entry.receptions, []);
  } finally {
    await local.interactions.settled();
    local.interactions.close();
  }
});

test('a missing remote response after tool execution ends the run with one recorded effect', async () => {
  const requests = [];
  const effects = [];
  const provider = new OpenAIResponsesProvider({
    ...route,
    continuation: 'previous-response-id',
    retry: { maxAttempts: 3 },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) return generation(body, true);
      return new Response('response expired', { status: 404 });
    },
  });
  const local = host((request) => provider.complete(request));
  const saves = journal();
  const scene = assembly(
    scenario('previous-response-id', ({ key }) => {
      effects.push(key);
      return { text: 'record ' + key };
    }),
    local,
    { store: saves.store, inspection: provider },
  );
  try {
    await assert.rejects(scene.runner.run(input));
    await assert.rejects(scene.runner.resume(saves.contextId));
    assert.deepEqual(
      requests.map((body) => body.previous_response_id),
      [undefined, 'resp_lookup'],
    );
    assert.deepEqual(effects, ['用户']);
    assert.deepEqual(
      scene.entity.values()[0].feedback.map((item) => item.toolCallId),
      ['call_lookup'],
    );
  } finally {
    await local.interactions.settled();
    local.interactions.close();
  }
});

for (const continuation of ['replay', 'previous-response-id'])
  test(`Responses ${continuation} checks replacement context before dispatch even without a host inspector`, async () => {
    const requests = [];
    const effects = [];
    const provider = new OpenAIResponsesProvider({
      ...route,
      continuation,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        return generation(body, requests.length === 1);
      },
    });
    const local = host((request) => provider.complete(request));
    const lookup = member('lookup', ({ key }) => {
      effects.push(key);
      return { text: 'found' };
    });
    const scene = assembly({ tools: { lookup }, policyVersion: 'dynamic', requestContext: { maxBytes: 512 } }, local, { context: { prepare: (prefix) => 'context for round ' + prefix.exchanges.length } });
    try {
      if (continuation === 'replay') {
        assert.equal(await scene.runner.run(input), 'found');
        assert.deepEqual(effects, ['用户']);
        assert.match(JSON.stringify(requests[1].input), /context for round 1/);
      } else {
        await assert.rejects(scene.runner.run(input));
        assert.deepEqual(effects, []);
        assert.equal(requests.length, 1);
        assert.deepEqual(scene.entity.values()[0].feedback, []);
      }
    } finally {
      await local.interactions.settled();
      local.interactions.close();
    }
  });

test('remote history protects an earlier tool image before running the next image-producing tool', async () => {
  const effects = [];
  const requests = [];
  const provider = new OpenAIResponsesProvider({
    ...route,
    continuation: 'previous-response-id',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const id = String(requests.length);
      return Response.json({ object: 'response', id: 'resp_' + id, model: route.model, status: 'completed', error: null, incomplete_details: null, store: true, previous_response_id: body.previous_response_id ?? null, output: [{ ...functionCall, id: 'fc_' + id, call_id: 'call_' + id, arguments: JSON.stringify({ key: id }) }] });
    },
  });
  const local = host((request) => provider.complete(request));
  const lookup = member('lookup', ({ key }) => {
    effects.push(key);
    return { text: 'image' };
  });
  lookup.result.succeeded = () => ({ status: 'ok', content: [{ kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' }] });
  const scene = assembly({ tools: { lookup }, policyVersion: 'images', imageContext: { retainLatestToolImages: 1 } }, local);
  try {
    await assert.rejects(scene.runner.run(input));
    assert.deepEqual(effects, ['1']);
    assert.deepEqual(
      requests.map((body) => body.previous_response_id),
      [undefined, 'resp_1'],
    );
    assert.match(JSON.stringify(requests[1].input), /data:image\/jpeg;base64,/);
    assert.deepEqual(scene.entity.values()[1].feedback, []);
  } finally {
    await local.interactions.settled();
    local.interactions.close();
  }
});
