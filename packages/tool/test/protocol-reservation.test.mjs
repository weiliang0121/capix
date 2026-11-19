import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { Node, checkpointPoint } from '@weiliang0121/capix-runtime';
import { AnthropicMessagesProvider, ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { assembly, codec, host, input, journal, member, call, reply, final } from './fixture.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const image = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };
const text = '"\\\n\u0000雪'.repeat(8192);
const ids = ['escape-"\\', 'image-result'];
const contents = [[{ kind: 'text', text }], Array.from({ length: 32 }, () => image)];
const toolUses = ids.map((id, index) => ({ type: 'tool_use', id, name: 'lookup', input: { key: String(index) } }));

test('Messages bounds escaped text, images and future context as slots close, at the wire limit and one byte below', async () => {
  let firstBound;
  for (const adjustment of [undefined, 0, -1]) {
    const bounds = [];
    const bodies = [];
    const maxWireRequestBytes = adjustment === undefined ? 2 * 1024 * 1024 : firstBound + adjustment;
    const provider = new AnthropicMessagesProvider({
      endpoint: 'https://offline.invalid/v1/messages',
      apiKey: 'offline',
      model: 'fixture',
      maxTokens: 4096,
      anthropicVersion: '2023-06-01',
      bindingId: 'fixture',
      maxWireRequestBytes,
      fetch: async (_url, { body }) => {
        bodies.push(body);
        const first = bodies.length === 1;
        return Response.json({ type: 'message', id: first ? 'batch' : 'done', role: 'assistant', model: 'fixture', content: first ? toolUses : [{ type: 'text', text: 'done' }], stop_reason: first ? 'tool_use' : 'end_turn' });
      },
    });
    const inspection = {
      inspectRequest: provider.inspectRequest.bind(provider),
      reserveWireBytes(request, reservation) {
        const value = provider.reserveWireBytes(request, reservation);
        bounds.push({ ids: reservation.feedback.map((slot) => slot.toolCallId), value });
        return value;
      },
    };
    const model = host((request) => provider.complete(request));
    const executions = [];
    const lookup = member('lookup', ({ key }) => {
      executions.push(key);
      return { text: key };
    });
    lookup.result.succeeded = ({ text: key }) => ({ status: 'ok', content: contents[Number(key)] });
    const maxFeedbackBytes = Math.max(...contents.map((content, index) => bytes({ toolCallId: ids[index], status: 'ok', content })));
    const fixture = assembly({ policyVersion: 'messages-capacity', tools: { lookup }, budgets: { maxFeedbackBytes }, requestContext: { maxBytes: 1024 } }, model, { inspection, context: { prepare: (prefix) => (prefix.exchanges.length ? '"雪\\'.repeat(100) : undefined) } });
    try {
      if (adjustment === -1) {
        await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_WIRE_REQUEST_LIMIT' && error.bytes === firstBound && error.limit === firstBound - 1 && error.phase === 'reserved');
        assert.deepEqual(executions, []);
        assert.equal(bodies.length, 1);
      } else {
        assert.equal(await fixture.runner.run(input), 'done');
        firstBound ??= bounds[0].value;
        assert.deepEqual(executions, ['0', '1']);
        assert.deepEqual(
          bounds.map((item) => item.ids),
          [ids, ids.slice(1)],
        );
        const actual = Buffer.byteLength(bodies[1]);
        assert.equal(provider.inspectRequest(model.sent[1]).wireBytes, actual);
        assert.ok(bounds.every(({ value }) => value >= actual));
      }
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  }
});

for (const source of ['host limit', 'provider limit'])
  test(`actual-only inspection with ${source} rejects unknown future wire growth before effects`, async () => {
    const limit = 2 * 1024 * 1024;
    for (const reserveWireBytes of [undefined, () => -1, () => NaN, () => Promise.reject(new Error('async reservation'))]) {
      const model = host(() => reply('batch', [call('a', 'lookup', { key: 'a' })]));
      const inspection = {
        inspectRequest: (request) => ({ requestBytes: bytes(request), wireBytes: bytes(request), ...(source === 'provider limit' ? { limits: { maxRequestBytes: limit, maxWireRequestBytes: limit } } : {}) }),
        ...(reserveWireBytes ? { reserveWireBytes } : {}),
      };
      const fixture = assembly({ policyVersion: 'custom-v1', capacityPolicy: 'defer', tools: { lookup: member('lookup', () => assert.fail('unreserved tool executed')) }, budgets: source === 'host limit' ? { maxWireRequestBytes: limit } : {} }, model, { inspection });
      try {
        await assert.rejects(fixture.runner.run(input), /reserveWireBytes|wire reservation/);
        assert.equal(model.sent.length, 1);
        assert.deepEqual(fixture.entity.snapshot().entries[0].feedback, []);
      } finally {
        await model.interactions.settled();
        model.interactions.close();
      }
    }
  });

test('known precheck rejection needs only actual inspection', async () => {
  const model = host((request) => (request.exchanges.length ? final : reply('rejected', [call('a', 'unknown', { key: 'a' })])));
  const inspection = { inspectRequest: (request) => ({ requestBytes: bytes(request), wireBytes: bytes(request) }) };
  const fixture = assembly({ policyVersion: 'known-v1', tools: { lookup: member('lookup', () => assert.fail('unknown tool executed')) }, budgets: { maxWireRequestBytes: 4096 } }, model, { inspection });
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.equal(JSON.parse(model.sent[1].exchanges[0].feedback[0].content[0].text).code, 'UNKNOWN_TOOL');
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
});

test('small images replaced with larger provenance text reserve the projected request before effects', async () => {
  const toolCallId = '"\\'.repeat(100);
  const content = Array.from({ length: 32 }, () => image);
  const maxFeedbackBytes = bytes({ toolCallId, status: 'ok', content });
  let actual;
  for (const constrained of [false, true]) {
    let executions = 0;
    const lookup = member('lookup', () => {
      executions++;
      return { text: '' };
    });
    lookup.result.succeeded = () => ({ status: 'ok', content });
    const model = host((request) => (request.exchanges.length ? final : reply('projection', [call(toolCallId, 'lookup', { key: 'a' })])));
    const budgets = { maxFeedbackBytes, ...(constrained ? { maxRequestBytes: actual - 1 } : {}) };
    const fixture = assembly({ policyVersion: 'image-window-v1', imageContext: { retainLatestToolImages: 0 }, tools: { lookup }, budgets }, model);
    try {
      if (constrained) {
        await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_REQUEST_LIMIT' && error.phase === 'reserved');
        assert.equal(executions, 0);
        assert.equal(model.sent.length, 1);
      } else {
        assert.equal(await fixture.runner.run(input), 'finished');
        actual = bytes(model.sent[1]);
        assert.equal(executions, 1);
        assert.ok(model.sent[1].exchanges[0].feedback[0].content.every((item) => item.kind === 'text' && item.text.includes(toolCallId)));
      }
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  }
});

test('image feedback reserves more JSON nodes than equally many text placeholders', async () => {
  const nodes = (value) => (value && typeof value === 'object' ? 1 + Object.values(value).reduce((sum, child) => sum + nodes(child), 0) : 1);
  let placeholderNodes;
  for (const constrained of [false, true]) {
    let executions = 0;
    const lookup = member('lookup', () => {
      executions++;
      return { text: 'image' };
    });
    lookup.result.succeeded = () => ({ status: 'ok', content: Array.from({ length: 32 }, () => image) });
    const model = host((request) => (request.exchanges.length ? final : reply('nodes', [call('a', 'lookup', { key: 'a' })])));
    const inspection = {
      inspectRequest(request) {
        if (request.exchanges.at(-1)?.feedback[0].content[0].text === '') placeholderNodes = nodes(request) + 31 * 3;
        return { requestBytes: bytes(request), wireBytes: bytes(request) };
      },
    };
    const fixture = assembly({ policyVersion: 'nodes-v1', tools: { lookup }, budgets: { maxFeedbackBytes: 8192 } }, model, { inspection });
    try {
      if (constrained) {
        // Keep 32 text parts inside the 100k-node domain, with <3 nodes
        // remaining for its 32 possible image parts. Each message has 3 nodes.
        const messages = Array.from({ length: 1 + Math.floor((100_000 - placeholderNodes) / 3) }, () => ({ role: 'user', content: '' }));
        await assert.rejects(fixture.runner.run({ request: { messages } }), /structural limits/);
        assert.equal(executions, 0);
        assert.equal(model.sent.length, 1);
      } else {
        assert.equal(await fixture.runner.run(input), 'finished');
        assert.ok(placeholderNodes > 100);
      }
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  }
});

test('resuming an existing member point checks the current wire reservation before any more member effects', async () => {
  const configuration = (effect) => {
    const prepared = checkpointPoint()({ name: 'prepared', state: codec, references: {}, resume: { run: () => effect() } });
    const lookup = member('lookup', effect, true);
    lookup.node = new Node({
      checkpoint: { key: 'pending-effect', version: 1, input: codec, output: codec, points: [prepared] },
      run(work) {
        work.checkpoint({ point: prepared, state: null, refs: {} });
        return effect();
      },
    });
    return { policyVersion: 'member-resume', checkpoint: true, capacityPolicy: 'defer', tools: { lookup }, budgets: { maxWireRequestBytes: 1024 * 1024 } };
  };
  const send = (request) => (request.exchanges.length ? final : reply('one', [call('a', 'lookup', { key: 'a' })]));
  const check = (limit) => ({
    inspectRequest: (request) => ({ requestBytes: bytes(request), wireBytes: bytes(request), limits: { maxRequestBytes: 1024 * 1024, maxWireRequestBytes: limit } }),
    reserveWireBytes: (request, reservation) => bytes(request) + reservation.feedback.reduce((sum, slot) => sum + slot.maxBytes, 0),
  });
  let original;
  let saved;
  const model = host(send);
  const checkpoints = journal((commit, count) => {
    if (commit.contract.key === 'pending-effect') saved = { count, states: structuredClone([...model.states]), entity: structuredClone(original.entity.snapshot()) };
  });
  original = assembly(
    configuration(() => ({ text: 'done' })),
    model,
    { inspection: check(1024 * 1024), store: checkpoints.store },
  );
  try {
    assert.equal(await original.runner.run(input), 'finished');
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
  assert.ok(saved);
  for (const constrained of [false, true]) {
    let effects = 0;
    const nextHost = host(send, new Map(saved.states));
    const next = assembly(
      configuration(() => {
        effects++;
        return { text: 'done' };
      }),
      nextHost,
      { inspection: check(constrained ? 3000 : 1024 * 1024), entity: ModelExchanges.restore(saved.entity), store: checkpoints.replay(saved.count) },
    );
    try {
      if (constrained) {
        await assert.rejects(next.runner.resume(checkpoints.contextId), /TOOL_WIRE_REQUEST_LIMIT/);
        assert.equal(effects, 0);
        assert.deepEqual(nextHost.sent, []);
        assert.deepEqual(next.entity.snapshot(), saved.entity);
      } else {
        assert.equal(await next.runner.resume(checkpoints.contextId), 'finished');
        assert.equal(effects, 1);
        assert.equal(nextHost.sent.length, 1);
      }
    } finally {
      await nextHost.interactions.settled();
      nextHost.interactions.close();
    }
  }
});

for (const protocol of ['chat', 'messages'])
  test(`${protocol} fits a small text-only member under 4 KiB with an empty image window`, async () => {
    const toolCallId = 'a';
    const maxFeedbackBytes = bytes({ toolCallId, status: 'ok', content: [{ kind: 'text', text: '' }] });
    const settings = { endpoint: 'https://offline.invalid', model: 'fixture', apiKey: 'offline', maxWireRequestBytes: 4096 };
    const provider =
      protocol === 'chat'
        ? new ChatCompletionsProvider({ ...settings, fetch: () => assert.fail('Chat uses injected Interaction') })
        : new AnthropicMessagesProvider({
            ...settings,
            maxTokens: 4096,
            bindingId: 'fixture',
            anthropicVersion: '2023-06-01',
            fetch: async (_url, { body }) => {
              const first = JSON.parse(body).messages.length === 1;
              return Response.json({ type: 'message', id: first ? 'one' : 'done', role: 'assistant', model: 'fixture', content: first ? [{ type: 'tool_use', id: toolCallId, name: 'lookup', input: { key: 'a' } }] : [{ type: 'text', text: 'finished' }], stop_reason: first ? 'tool_use' : 'end_turn' });
            },
          });
    let effects = 0;
    const lookup = member('lookup', () => {
      effects++;
      return { text: '' };
    });
    const model = host((request) => (protocol === 'messages' ? provider.complete(request) : request.exchanges.length ? final : reply('one', [call(toolCallId, 'lookup', { key: 'a' })])));
    const inspection = {
      inspectRequest: provider.inspectRequest.bind(provider),
      reserveWireBytes(request, reservation) {
        assert.equal(reservation.imageOmissionBytes ?? 0, 0);
        assert.deepEqual(reservation.feedback, [{ toolCallId, maxBytes: maxFeedbackBytes }]);
        return provider.reserveWireBytes(request, reservation);
      },
    };
    const fixture = assembly({ policyVersion: 'tiny-text', tools: { lookup }, imageContext: { retainLatestToolImages: 0 }, budgets: { maxFeedbackBytes } }, model, { inspection });
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(effects, 1);
      assert.equal(model.sent.length, 2);
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });
