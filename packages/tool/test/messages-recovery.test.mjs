import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { AnthropicMessagesProvider } from '@weiliang0121/capix-model-provider';
import { assembly, host, input, journal, member } from './fixture.mjs';

const route = { endpoint: 'https://messages.invalid/v1/messages', model: 'model-alias', anthropicVersion: '2023-06-01', bindingId: 'offline-deployment', apiKey: 'offline-fixture', maxTokens: 4096 };
const blocks = [
  { type: 'thinking', thinking: 'Check both records.', signature: 'offline-signature' },
  { type: 'text', text: 'Looking up two records.' },
  { type: 'tool_use', id: 'toolu_a', name: 'lookup', input: { key: 'A' } },
  { type: 'tool_use', id: 'toolu_b', name: 'lookup', input: { key: 'B' } },
];

function message(first) {
  return { type: 'message', id: first ? 'msg_1' : 'msg_2', role: 'assistant', model: 'model-snapshot', content: first ? structuredClone(blocks) : [{ type: 'text', text: 'complete' }], stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 24, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
function configuration(run) {
  return { policyVersion: 'messages-deployment-v1', checkpoint: true, tools: { lookup: member('lookup', run, true) } };
}

test('Messages Tool replays native blocks and real feedback, then cold-confirms the completed call without a sender', async () => {
  const requests = [];
  const lookedUp = [];
  const provider = new AnthropicMessagesProvider({
    ...route,
    fetch: async (url, init) => {
      assert.equal(url, route.endpoint);
      requests.push(JSON.parse(init.body));
      return Response.json(message(requests.length === 1));
    },
  });
  const sender = host((request) => provider.complete(request));
  const saves = journal();
  const scene = assembly(
    configuration(({ key }) => {
      lookedUp.push(key);
      return { text: 'result ' + key };
    }),
    sender,
    { store: saves.store, inspection: provider },
  );
  try {
    assert.equal(await scene.runner.run(input), 'complete');
    assert.equal(requests.length, 2);
    assert.deepEqual(lookedUp, ['A', 'B']);
    const [assistant, feedback] = requests[1].messages.slice(-2);
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content, blocks);
    assert.equal(feedback.role, 'user');
    assert.deepEqual(
      feedback.content.map(({ type, tool_use_id }) => [type, tool_use_id]),
      [
        ['tool_result', 'toolu_a'],
        ['tool_result', 'toolu_b'],
      ],
    );
    assert.match(JSON.stringify(feedback.content[0].content), /result A/);
    assert.match(JSON.stringify(feedback.content[1].content), /result B/);
  } finally {
    await sender.interactions.settled();
    sender.interactions.close();
  }
  const snapshot = JSON.parse(JSON.stringify(scene.entity.snapshot()));
  for (const change of ['none', 'durable-signature', 'route-policy']) {
    const states = new Map(structuredClone([...sender.states]));
    if (change === 'durable-signature') {
      const first = [...states.values()].find((state) => state.feedback.payload.id === 'msg_1');
      first.feedback.payload.native.blocks[0].signature = 'another-signature';
    }
    const restoredHost = host(() => assert.fail('completed checkpoint sent a model request'), states);
    const config = configuration(() => assert.fail('completed checkpoint re-executed a tool'));
    if (change === 'route-policy') config.policyVersion = 'different-deployment-v2';
    const restored = assembly(config, restoredHost, { store: saves.replay(), entity: ModelExchanges.restore(snapshot) });
    try {
      if (change === 'none') assert.equal(await restored.runner.resume(saves.contextId), 'complete');
      else await assert.rejects(restored.runner.resume(saves.contextId));
      assert.deepEqual(restoredHost.sent, []);
      assert.deepEqual(restored.entity.snapshot(), snapshot);
    } finally {
      await restoredHost.interactions.settled();
      restoredHost.interactions.close();
    }
  }
});

test('Messages max_tokens reaches the exchange and prevents every tool effect in a truncated batch', async () => {
  const events = [
    { type: 'message_start', message: { ...message(true), content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: blocks[2] },
    { type: 'content_block_stop', index: 0 },
    // The first call already has valid input when the second call runs out of tokens.
    { type: 'content_block_start', index: 1, content_block: { ...blocks[3], input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key":' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 13 } },
    { type: 'message_stop' },
  ];
  let requests = 0;
  const effects = [];
  const provider = new AnthropicMessagesProvider({
    ...route,
    fetch: async () => {
      requests++;
      return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const sender = host((request) => provider.complete(request));
  const lookup = member('lookup', ({ key }) => {
    effects.push(key);
    return { text: key };
  });
  const scene = assembly({ policyVersion: 'truncated-batch', tools: { lookup } }, sender, { inspection: provider });
  try {
    await assert.rejects(scene.runner.run({ request: { ...input.request, stream: true } }), /Incomplete model reply cannot execute tools/);
    const [entry] = scene.entity.values();
    assert.deepEqual(entry.reply.termination, { kind: 'incomplete', reason: 'max_tokens' });
    assert.deepEqual(
      entry.reply.output.map((call) => call.id),
      ['toolu_a'],
    );
    assert.deepEqual(entry.feedback, []);
    assert.deepEqual(effects, []);
    assert.equal(requests, 1);
  } finally {
    await sender.interactions.settled();
    sender.interactions.close();
  }
});

test('Messages rejects another deployment’s continuation before running the proposed tools', async () => {
  const previous = new AnthropicMessagesProvider({ ...route, bindingId: 'another-deployment', fetch: async () => Response.json(message(true)) });
  const active = new AnthropicMessagesProvider({ ...route, fetch: () => assert.fail('rejected continuation reached transport') });
  const sender = host((request) => previous.complete(request));
  let executions = 0;
  const scene = assembly(
    configuration(() => {
      executions++;
      return { text: 'unexpected' };
    }),
    sender,
    { store: journal().store, inspection: active },
  );
  try {
    await assert.rejects(scene.runner.run(input));
    assert.equal(executions, 0);
    assert.equal(sender.sent.length, 1);
  } finally {
    await sender.interactions.settled();
    sender.interactions.close();
  }
});

for (const inspected of [false, true])
  test(`Messages Tool rejects a changing context before signed tool effects (inspection=${inspected})`, async () => {
    let fetches = 0;
    let executions = 0;
    const provider = new AnthropicMessagesProvider({
      ...route,
      fetch: async () => {
        fetches++;
        return Response.json(message(true));
      },
    });
    const sender = host((request) => provider.complete(request));
    const config = configuration(() => {
      executions++;
      return { text: 'unexpected' };
    });
    const scene = assembly({ ...config, requestContext: { maxBytes: 512 } }, sender, { store: journal().store, inspection: inspected ? provider : undefined, context: { prepare: () => 'context selected at this round' } });
    try {
      await assert.rejects(scene.runner.run(input));
      assert.equal(fetches, 1);
      assert.equal(executions, 0);
      assert.deepEqual(scene.entity.values()[0].feedback, []);
    } finally {
      await sender.interactions.settled();
      sender.interactions.close();
    }
  });

for (const inspected of [false, true])
  test(`Messages Tool protects earlier signed images before running the next tool (inspection=${inspected})`, async () => {
    const executions = [];
    const requests = [];
    const provider = new AnthropicMessagesProvider({
      ...route,
      fetch: async (_url, { body }) => {
        requests.push(JSON.parse(body));
        const call = requests.length === 1 ? blocks[2] : blocks[3];
        return Response.json({ ...message(true), id: 'msg_' + requests.length, content: [blocks[0], call] });
      },
    });
    const sender = host((request) => provider.complete(request));
    const lookup = member('lookup', ({ key }) => {
      executions.push(key);
      return { text: 'image' };
    });
    const image = { kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' };
    lookup.result.succeeded = () => ({ status: 'ok', content: [image] });
    const scene = assembly({ policyVersion: 'signed-image-retention-v1', tools: { lookup }, imageContext: { retainLatestToolImages: 1 } }, sender, { inspection: inspected ? provider : undefined });
    try {
      await assert.rejects(scene.runner.run(input), /Image retention can change a signed Messages prefix/);
      assert.deepEqual(executions, ['A']);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].messages.at(-1).content[0].content[0].source.data, image.data);
      assert.deepEqual(scene.entity.values()[1].feedback, []);
    } finally {
      await sender.interactions.settled();
      sender.interactions.close();
    }
  });
