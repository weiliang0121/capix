import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, createCheckpointValueBlock } from '@weiliang0121/capix-checkpoint';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ToolBudgetError, ToolModelCallLimitError } from '@weiliang0121/capix-tool';
import { assembly, member, host, journal, input, reply, call, final } from './fixture.mjs';
// The injected test transport serializes the common request as its wire body.
function reserveJsonWireBytes(request, { feedback, contextGrowthBytes }) {
  const projected = request.exchanges.at(-1).feedback;
  return this.inspectRequest(request).wireBytes + contextGrowthBytes + feedback.reduce((total, slot) => total + slot.maxBytes - Buffer.byteLength(JSON.stringify(projected.find((item) => item.toolCallId === slot.toolCallId))), 0);
}
const close = async (model) => {
  await model.interactions.settled();
  model.interactions.close();
};
const send = (request) => (request.exchanges.length ? final : reply('batch', [call('a', 'lookup', { key: 'a' }), call('b', 'lookup', { key: 'b' })]));
function config(checkpoint = false, options = {}) {
  return { policyVersion: 'capacity.v1', checkpoint, capacityPolicy: 'defer', requestContext: { maxBytes: 1024 }, budgets: { maxFeedbackBytes: 4096, maxRequestBytes: 6000 }, tools: { lookup: member('lookup', () => assert.fail('deferred tool must not execute'), checkpoint) }, ...options };
}
for (const checkpoint of [false, true])
  test(`capacity defers an entire first batch with exact host boundary (checkpoint=${checkpoint})`, async () => {
    const model = host(send);
    const boundaries = [];
    const fixture = assembly(config(checkpoint), model, {
      ...(checkpoint ? { store: journal().store } : {}),
      context: {
        prepare(prefix, boundary) {
          boundaries.push(boundary);
          if (boundary) {
            assert.deepEqual(boundary.exchange, prefix.exchanges.at(-1));
            assert.deepEqual(boundary.callIds, ['a', 'b']);
            assert.ok(Object.isFrozen(boundary));
          }
        },
      },
    });
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(boundaries[0], undefined);
      assert.equal(boundaries[1].reason.code, 'TOOL_REQUEST_LIMIT');
      const entry = fixture.entity.snapshot().entries[0];
      assert.equal(entry.receptions.length, 0);
      for (const feedback of entry.feedback) {
        const value = JSON.parse(feedback.content[0].text);
        assert.equal(value.code, 'TOOL_CAPACITY_DEFERRED');
        assert.equal(value.executed, false);
      }
    } finally {
      await close(model);
    }
  });
for (const variant of ['default', 'inspector', 'feedback', 'collection', 'closure', 'wire', 'loop'])
  test(`capacity preserves ${variant} boundary`, async () => {
    const model = host(variant === 'loop' ? () => reply('batch', [call('a', 'lookup', { key: 'a' }), call('b', 'lookup', { key: 'b' })]) : send);
    const sentinel = new ToolBudgetError('TOOL_REQUEST_LIMIT', 10000, 6000, 'reserved');
    const options = variant === 'default' ? { capacityPolicy: undefined } : variant === 'feedback' ? { requestContext: { maxBytes: 10000 }, budgets: { maxFeedbackBytes: 100, maxRequestBytes: 6000 } } : variant === 'collection' ? { budgets: { maxReplyBytes: 1024, maxCollectionBytes: 30000, maxFeedbackBytes: 4096, maxRequestBytes: 6000 } } : variant === 'closure' ? { budgets: { maxFeedbackBytes: 4096, maxRequestBytes: 1000 } } : variant === 'wire' ? { budgets: { maxFeedbackBytes: 4096, maxWireRequestBytes: 6000 } } : variant === 'loop' ? { maxModelCalls: 2 } : {};
    const inspection = {
      reserveWireBytes: reserveJsonWireBytes,
      inspectRequest(request) {
        if (variant === 'inspector' && request.exchanges?.length) throw sentinel;
        return { requestBytes: Buffer.byteLength(JSON.stringify(request)), wireBytes: Buffer.byteLength(JSON.stringify(request)) };
      },
    };
    const boundaries = [];
    const fixture = assembly(config(false, options), model, {
      inspection,
      context: {
        prepare(_prefix, boundary) {
          boundaries.push(boundary);
        },
      },
    });
    try {
      if (variant === 'wire') assert.equal(await fixture.runner.run(input), 'finished');
      else if (variant === 'inspector') await assert.rejects(fixture.runner.run(input), (error) => error === sentinel);
      else if (variant === 'closure') await assert.rejects(fixture.runner.run(input), (error) => error instanceof ToolBudgetError && error.code === 'TOOL_REQUEST_LIMIT' && error.phase === 'actual');
      else await assert.rejects(fixture.runner.run(input), variant === 'loop' ? ToolModelCallLimitError : /TOOL_/);
      if (['inspector', 'closure'].includes(variant)) assert.deepEqual(boundaries, [undefined]);
      if (!['wire', 'loop'].includes(variant)) assert.equal(fixture.entity.snapshot().entries[0]?.feedback.length ?? 0, 0);
    } finally {
      await close(model);
    }
  });

test('partial, closed and waiting deferred checkpoints recover without effects; tampering fails', async () => {
  const model = host(send);
  let fixture;
  const snapshots = [];
  const saves = journal((commit, count) => {
    if ((commit.contract.key === 'capix.tool' && ['tools', 'completed'].includes(commit.point)) || (commit.contract.key === 'tool.completion' && commit.point === 'completed')) snapshots.push({ count, point: commit.point, entity: structuredClone(fixture.entity.snapshot()), states: structuredClone([...model.states]) });
  });
  fixture = assembly(config(true), model, { store: saves.store, context: { prepare() {} } });
  assert.equal(await fixture.runner.run(input), 'finished');
  await close(model);
  const selected = snapshots.filter((snapshot) => snapshot.entity.entries[0]?.feedback.length > 0);
  assert.ok(selected.some((snapshot) => snapshot.entity.entries[0].feedback.length === 1));
  assert.ok(selected.some((snapshot) => snapshot.point === 'completed'));
  for (const snapshot of selected) {
    for (const tamper of [false, true]) {
      const entity = structuredClone(snapshot.entity);
      if (tamper) entity.entries[0].feedback[0].content[0].text = entity.entries[0].feedback[0].content[0].text.replace('"executed":false', '"executed":true');
      const nextHost = host(send, new Map(snapshot.states));
      const next = assembly(config(true), nextHost, { entity: ModelExchanges.restore(entity), store: saves.replay(snapshot.count), context: { prepare() {} } });
      try {
        if (tamper) await assert.rejects(next.runner.resume(saves.contextId));
        else assert.equal(await next.runner.resume(saves.contextId), 'finished');
      } finally {
        await close(nextHost);
      }
    }
  }
});

test('defer preserves an already accepted child and its exact receipt through cold recovery', async () => {
  const effects = [];
  const configuration = () =>
    config(true, {
      budgets: { maxFeedbackBytes: 4096, maxRequestBytes: 12000 },
      tools: {
        lookup: member(
          'lookup',
          (value) => {
            effects.push(value.key);
            return { text: 'accepted-result' };
          },
          true,
        ),
      },
    });
  const inspection = {
    inspectRequest(request) {
      const feedback = request.exchanges?.at(-1)?.feedback ?? [];
      const reservedAfterEffect = feedback.some((value) => value.content[0]?.text === 'accepted-result') && feedback.some((value) => value.content[0]?.text === '');
      const bytes = Buffer.byteLength(JSON.stringify(request));
      return { requestBytes: reservedAfterEffect ? 12001 : bytes, wireBytes: bytes };
    },
  };
  const model = host(send);
  let fixture;
  let partial;
  const saves = journal((commit, count) => {
    if (commit.contract.key === 'capix.tool' && commit.point === 'tools' && fixture.entity.snapshot().entries[0]?.feedback.length === 2) partial = { count, entity: structuredClone(fixture.entity.snapshot()), states: structuredClone([...model.states]) };
  });
  fixture = assembly(configuration(), model, { inspection, store: saves.store, context: { prepare() {} } });
  assert.equal(await fixture.runner.run(input), 'finished');
  await close(model);
  assert.deepEqual(effects, ['a']);
  const snapshot = structuredClone(fixture.entity.snapshot());
  assert.equal(snapshot.entries[0].receptions.length, 1);
  assert.equal(snapshot.entries[0].feedback[0].content[0].text, 'accepted-result');
  assert.equal(JSON.parse(snapshot.entries[0].feedback[1].content[0].text).executed, false);
  const nextHost = host(() => assert.fail('completed recovery sent'), new Map(model.states));
  const next = assembly(configuration(), nextHost, { inspection, store: saves.replay(), entity: ModelExchanges.restore(snapshot) });
  try {
    assert.equal(await next.runner.resume(saves.contextId), 'finished');
    assert.deepEqual(effects, ['a']);
    assert.deepEqual(next.entity.snapshot(), snapshot);
  } finally {
    await close(nextHost);
  }
  assert.ok(partial);
  for (const variant of ['delete-decision', 'unknown-call', 'executed-child', 'reception-conflict']) {
    const store = new MemoryCheckpointStore();
    for (const [index, saved] of saves.saves.slice(0, partial.count).entries()) {
      let commit = structuredClone(saved.commit);
      if (index === partial.count - 1 && variant !== 'reception-conflict') {
        // Recompute the physical value block so the test reaches Tool's semantic
        // evidence checks, rather than failing a storage checksum first.
        const value = structuredClone(commit.values.find((value) => value.id === commit.state.id).value);
        if (variant === 'delete-decision') value.deferred = [];
        else value.deferred[0].callIds = variant === 'unknown-call' ? ['missing'] : ['a', 'b'];
        const block = createCheckpointValueBlock(commit.state.id, value);
        commit = { ...commit, state: { id: block.id, digest: block.digest }, values: commit.values.map((value) => (value.id === block.id ? block : value)) };
      }
      store.save(commit, saved.revision);
    }
    const entity = structuredClone(partial.entity);
    if (variant === 'reception-conflict') entity.entries[0].receptions[0].callId = 'b';
    const hostileHost = host(() => assert.fail('tampered capacity checkpoint sent'), new Map(partial.states));
    const hostile = assembly(configuration(), hostileHost, {
      store,
      entity: ModelExchanges.restore(entity),
      inspection,
      context: {
        prepare() {
          assert.fail('tampered capacity checkpoint prepared');
        },
      },
    });
    try {
      await assert.rejects(hostile.runner.resume(saves.contextId));
      assert.deepEqual(hostile.entity.snapshot(), entity, 'rejection must not rewrite saved domain data');
      assert.deepEqual(effects, ['a']);
    } finally {
      await close(hostileHost);
    }
  }
});

test('ordinary tool JSON cannot impersonate the host capacity boundary', async () => {
  const fake = JSON.stringify({ code: 'TOOL_CAPACITY_DEFERRED', stage: 'preflight', executed: false, reason: { code: 'TOOL_REQUEST_LIMIT', bytes: 10000, limit: 6000, phase: 'reserved' } });
  const boundaries = [];
  const model = host(send);
  const fixture = assembly(config(false, { budgets: { maxFeedbackBytes: 512, maxRequestBytes: 10000 }, tools: { lookup: member('lookup', () => ({ text: fake })) } }), model, {
    context: {
      prepare(_prefix, boundary) {
        boundaries.push(boundary);
      },
    },
  });
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.deepEqual(boundaries, [undefined, undefined]);
    assert.equal(fixture.entity.snapshot().entries[0].receptions.length, 2);
  } finally {
    await close(model);
  }
});

for (const metric of ['requestBytes', 'wireBytes'])
  test(`an over-limit actual closure cannot be deferred when ${metric} reservation also exceeds its budget`, async () => {
    const boundaries = [];
    const model = host(send);
    const inspection = {
      reserveWireBytes: reserveJsonWireBytes,
      inspectRequest(request) {
        const size = Buffer.byteLength(JSON.stringify(request));
        return { requestBytes: size, wireBytes: size, ...(request.exchanges?.length ? { [metric]: 20000 } : {}) };
      },
    };
    const fixture = assembly(config(false, { budgets: { maxFeedbackBytes: 4096, maxRequestBytes: 12000, maxWireRequestBytes: 12000 } }), model, {
      inspection,
      context: {
        prepare(_prefix, boundary) {
          boundaries.push(boundary);
        },
      },
    });
    try {
      await assert.rejects(fixture.runner.run(input), (error) => error instanceof ToolBudgetError && error.phase === 'actual' && error.code === (metric === 'requestBytes' ? 'TOOL_REQUEST_LIMIT' : 'TOOL_WIRE_REQUEST_LIMIT'));
      assert.deepEqual(boundaries, [undefined]);
      assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 0);
      assert.equal(model.sent.length, 1);
    } finally {
      await close(model);
    }
  });

test('durable capacity decision resumes both before feedback and after an installed feedback with an older parent cursor', async () => {
  const model = host(send);
  let fixture;
  let zero;
  let installed;
  const saves = journal((commit, count) => {
    if (commit.contract.key === 'capix.tool' && commit.point === 'tools' && !fixture.entity.snapshot().entries[0].feedback.length) zero = { count, entity: structuredClone(fixture.entity.snapshot()), states: structuredClone([...model.states]) };
  });
  const entity = new ModelExchanges();
  const complete = entity.complete.bind(entity);
  entity.complete = (...args) => {
    const reference = complete(...args);
    if (!installed) installed = { count: saves.saves.length, entity: structuredClone(entity.snapshot()), states: structuredClone([...model.states]) };
    return reference;
  };
  fixture = assembly(config(true), model, { entity, store: saves.store, context: { prepare() {} } });
  assert.equal(await fixture.runner.run(input), 'finished');
  await close(model);
  assert.ok(zero);
  assert.ok(installed);
  assert.equal(zero.count, installed.count, 'no new checkpoint exists between durable decision and first installed feedback');
  for (const snapshot of [zero, installed]) {
    const nextHost = host(send, new Map(snapshot.states));
    const restoredEntity = ModelExchanges.restore(snapshot.entity);
    const beforeSequence = restoredEntity.snapshot().entries[0].revision;
    const next = assembly(config(true), nextHost, { entity: restoredEntity, store: saves.replay(snapshot.count), context: { prepare() {} } });
    try {
      assert.equal(await next.runner.resume(saves.contextId), 'finished');
      const entry = next.entity.snapshot().entries[0];
      assert.equal(entry.feedback.length, 2);
      assert.equal(entry.receptions.length, 0);
      assert.equal(entry.revision - beforeSequence, 2 - snapshot.entity.entries[0].feedback.length, 'already installed feedback must not produce another entity revision');
      assert.deepEqual(entry.feedback[0], fixture.entity.snapshot().entries[0].feedback[0]);
    } finally {
      await close(nextHost);
    }
  }
});

for (const scope of ['wire', 'exchange'])
  test(`a ${scope} capacity decision defers before effects and authenticates its limit on cold recovery`, async () => {
    const { ChatCompletionsProvider, maximumModelExchangeBytes } = await import('@weiliang0121/capix-model-provider');
    const inspector = (wireLimit = 6000) => new ChatCompletionsProvider({ endpoint: 'https://offline.invalid', apiKey: 'offline', model: 'fixture', maxRequestBytes: 8 * 1024 * 1024, maxWireRequestBytes: scope === 'wire' ? wireLimit : 8 * 1024 * 1024 });
    const configuration = () => config(true, { budgets: { maxFeedbackBytes: scope === 'exchange' ? 1200 * 1024 : 4096, maxRequestBytes: 8 * 1024 * 1024, maxWireRequestBytes: 8 * 1024 * 1024 } });
    const model = host(send);
    const boundaries = [];
    const saves = journal();
    const fixture = assembly(configuration(), model, {
      store: saves.store,
      inspection: inspector(),
      context: {
        prepare(_prefix, boundary) {
          if (boundary) boundaries.push(boundary);
        },
      },
    });
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(boundaries.length, 1);
      assert.equal(boundaries[0].reason.code, scope === 'wire' ? 'TOOL_WIRE_REQUEST_LIMIT' : 'TOOL_EXCHANGE_LIMIT');
      assert.equal(boundaries[0].reason.limit, scope === 'wire' ? 6000 : maximumModelExchangeBytes);
      assert.equal(fixture.entity.snapshot().entries[0].receptions.length, 0);
    } finally {
      await close(model);
    }
    for (const changed of scope === 'wire' ? [false, true] : [false]) {
      const snapshot = structuredClone(fixture.entity.snapshot());
      const nextHost = host(() => assert.fail('completed recovery must not send'), new Map(model.states));
      const next = assembly(configuration(), nextHost, {
        store: saves.replay(),
        entity: ModelExchanges.restore(snapshot),
        inspection: inspector(changed ? 6001 : 6000),
        context: {
          prepare() {
            assert.fail('completed recovery must not prepare');
          },
        },
      });
      try {
        if (changed) await assert.rejects(next.runner.resume(saves.contextId));
        else assert.equal(await next.runner.resume(saves.contextId), 'finished');
        assert.deepEqual(next.entity.snapshot(), snapshot);
      } finally {
        await close(nextHost);
      }
    }
  });

for (const room of [550, 10])
  test(`under the exchange hard limit with ${room} spare bytes, only a real fitting defer feedback can close the exchange`, async () => {
    const maximum = 2 * 1024 * 1024;
    const batch = reply('near-hard-limit', [call('a', 'lookup', { key: 'a' })]);
    batch.native.reasoningContent = '';
    const minimum = { reply: batch, feedback: [{ toolCallId: 'a', status: 'ok', content: [{ kind: 'text', text: '' }] }] };
    batch.native.reasoningContent = 'x'.repeat(maximum - room - Buffer.byteLength(JSON.stringify(minimum)));
    assert.equal(Buffer.byteLength(JSON.stringify(minimum)), maximum - room);
    const model = host((request) => (request.exchanges.length ? final : batch));
    let effects = 0;
    const fixture = assembly(
      {
        policyVersion: 'hard-cap-defer',
        capacityPolicy: 'defer',
        tools: {
          lookup: member('lookup', () => {
            effects++;
            return { text: 'effect' };
          }),
        },
        budgets: { maxFeedbackBytes: 4096, maxReplyBytes: maximum, maxRequestBytes: 2 * maximum },
      },
      model,
    );
    try {
      if (room === 550) {
        assert.equal(await fixture.runner.run(input), 'finished');
        const rejection = JSON.parse(model.sent[1].exchanges[0].feedback[0].content[0].text);
        assert.equal(rejection.code, 'TOOL_CAPACITY_DEFERRED');
        assert.equal(rejection.reason.code, 'TOOL_EXCHANGE_LIMIT');
        assert.equal(rejection.reason.limit, maximum);
        assert.equal(rejection.executed, false);
      } else {
        await assert.rejects(fixture.runner.run(input), /byte limit/);
        assert.equal(model.sent.length, 1);
        assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 0);
      }
      assert.equal(effects, 0);
    } finally {
      await close(model);
    }
  });

test('a mixed batch can defer a large uninstalled schema rejection at the exchange hard limit', async () => {
  const { z } = await import('zod');
  const maximum = 2 * 1024 * 1024;
  const fields = Array.from({ length: 6 }, (_, i) => 'field' + String(i).padEnd(55, 'x'));
  const valid = Object.fromEntries(fields.map((key) => [key, 'ok']));
  const batch = reply('mixed-hard-limit', [call('a', 'lookup', valid), call('b', 'lookup', {})]);
  const minimum = { reply: batch, feedback: ['a', 'b'].map((toolCallId) => ({ toolCallId, status: 'ok', content: [{ kind: 'text', text: '' }] })) };
  for (const constrained of [false, true]) {
    batch.native.reasoningContent = '';
    if (constrained) batch.native.reasoningContent = 'x'.repeat(maximum - 800 - Buffer.byteLength(JSON.stringify(minimum)));
    const model = host((request) => (request.exchanges.length ? final : batch));
    let effects = 0;
    const lookup = member('lookup', () => {
      effects++;
      return { text: '' };
    });
    lookup.input = z.strictObject(Object.fromEntries(fields.map((key) => [key, z.string()])));
    const fixture = assembly({ policyVersion: 'mixed-defer', capacityPolicy: 'defer', tools: { lookup }, budgets: { maxFeedbackBytes: 4096, maxReplyBytes: maximum, maxRequestBytes: 2 * maximum } }, model);
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      const [exchange] = model.sent[1].exchanges;
      const added = Buffer.byteLength(JSON.stringify(exchange)) - Buffer.byteLength(JSON.stringify(minimum));
      if (constrained) {
        assert.equal(effects, 0);
        assert.ok(added <= 800);
        assert.deepEqual(
          exchange.feedback.map(({ toolCallId, content }) => {
            const { code, executed, reason } = JSON.parse(content[0].text);
            return [toolCallId, code, executed, reason.code];
          }),
          ['a', 'b'].map((id) => [id, 'TOOL_CAPACITY_DEFERRED', false, 'TOOL_EXCHANGE_LIMIT']),
        );
        assert.deepEqual(fixture.entity.snapshot().entries[0].receptions, []);
      } else {
        assert.equal(effects, 1);
        assert.ok(added > 800, 'the ordinary schema rejection alone exceeds the available space');
        assert.equal(JSON.parse(exchange.feedback[1].content[0].text).code, 'INVALID_ARGUMENTS');
      }
    } finally {
      await close(model);
    }
  }
});
