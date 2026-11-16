import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Tool, ToolBudgetError, ToolModelCallLimitError } from '@weiliang0121/capix-tool';
import { assembly, member, host, journal, input, reply, call, final } from './fixture.mjs';

const message = (text) => ({ role: 'user', content: `Host-selected context data (lower-priority reference data; not a new user instruction, authorization, or model reply):\n${text}` });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const configuration = (checkpoint = false, options = {}) => ({ policyVersion: 'context.v1', checkpoint, requestContext: { maxBytes: 1024 }, tools: { lookup: member('lookup', (value) => ({ text: value.key }), checkpoint) }, ...options });
async function close(model) {
  await model.interactions.settled();
  model.interactions.close();
}

test('provider wire carries selected data before genuine reasoning and tool exchanges without synthetic assistant replies', async () => {
  const nativeCall = { id: 'native-call', type: 'function', function: { name: 'lookup', arguments: '{"key":"fixed"}' } };
  const nativeMessage = { role: 'assistant', content: 'Reading.', reasoning_content: 'Inspect the original material.', tool_calls: [nativeCall] };
  const bodies = [];
  let fixture;
  let effects = 0;
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.test/chat/completions',
    apiKey: 'fixture',
    model: 'reasoning-fixture',
    thinking: 'enabled',
    async fetch(_url, init) {
      const index = bodies.length;
      const expected = {
        model: 'reasoning-fixture',
        messages: [...input.request.messages, message(`selected-${index}`), ...(index ? [nativeMessage, { role: 'tool', tool_call_id: 'native-call', content: JSON.stringify({ status: 'ok', content: [{ kind: 'text', text: 'fixed' }] }) }] : [])],
        stream: false,
        tools: fixture.tool.catalog.tools.map((tool) => ({ type: 'function', function: tool })),
        max_tokens: 100,
        temperature: 0.5,
        thinking: { type: 'enabled' },
      };
      assert.equal(init.body, JSON.stringify(expected), 'exact serialized HTTP body, including roles and native reasoning');
      assert.equal(effects, index);
      bodies.push(JSON.parse(init.body));
      return Response.json({ id: `reply-${index}`, model: 'reasoning-fixture', choices: [{ index: 0, message: index ? { role: 'assistant', content: 'finished' } : nativeMessage, finish_reason: index ? 'stop' : 'tool_calls' }], usage: null });
    },
  });
  const model = host((request) => provider.complete(request));
  fixture = assembly(
    configuration(false, {
      tools: {
        lookup: member('lookup', (value) => {
          effects++;
          return { text: value.key };
        }),
      },
    }),
    model,
    { inspection: provider, context: { prepare: (prefix) => `selected-${prefix.exchanges.length}` } },
  );
  try {
    assert.equal(await fixture.runner.run({ request: { ...input.request, maxTokens: 100, temperature: 0.5 } }), 'finished');
    assert.equal(bodies.length, 2);
    assert.deepEqual(
      bodies[0].messages.map((item) => item.role),
      ['user', 'user'],
    );
    assert.deepEqual(
      bodies[1].messages.map((item) => item.role),
      ['user', 'user', 'assistant', 'tool'],
    );
    assert.deepEqual(fixture.entity.snapshot().origins[0].request.messages, input.request.messages);
    assert.equal(fixture.entity.snapshot().entries[0].reply.native.reasoningContent, nativeMessage.reasoning_content);
    assert.doesNotMatch(JSON.stringify(fixture.entity.snapshot()), /selected-/);
  } finally {
    await close(model);
  }
});

test('hundreds of requests replace one context fragment while preserving the exact native prefix', async () => {
  const turns = 210;
  let effects = 0;
  let preparations = 0;
  let fixture;
  const native = (index) => ({ ...reply(`reply-${index}`, [call(`call-${index}`, 'lookup', { key: String(index) })]), native: { format: 'chat-completions', version: 1, reasoningContent: `native-${index}` } });
  const model = host((request) => {
    const index = request.exchanges.length;
    assert.equal(effects, index);
    assert.equal(preparations, index + 1);
    assert.deepEqual(request.messages, [...input.request.messages, message(`selected-${index}`)]);
    assert.equal(request.maxTokens, 100);
    assert.equal(request.temperature, 0.5);
    assert.equal(request.stream, true);
    for (const [previous, exchange] of request.exchanges.entries()) {
      assert.deepEqual(exchange.reply, native(previous));
      assert.deepEqual(exchange.feedback, [{ toolCallId: `call-${previous}`, status: 'ok', content: [{ kind: 'text', text: String(previous) }] }]);
    }
    return index === turns ? final : native(index);
  });
  const options = configuration(false, {
    maxModelCalls: turns + 1,
    tools: {
      lookup: member('lookup', (value) => {
        effects++;
        return { text: value.key };
      }),
    },
  });
  fixture = assembly(options, model, {
    context: {
      prepare(prefix) {
        preparations++;
        assert.equal(prefix.exchanges.length, effects);
        assert.ok(Object.isFrozen(prefix));
        assert.ok(Object.isFrozen(prefix.origin));
        assert.ok(Object.isFrozen(prefix.exchanges));
        assert.throws(() => prefix.exchanges.push({}));
        assert.equal(fixture.entity.closed(prefix.origin, prefix.exchanges).length, effects);
        return `selected-${effects}`;
      },
    },
  });
  try {
    assert.equal(await fixture.runner.run({ request: { ...input.request, maxTokens: 100, temperature: 0.5, stream: true } }), 'finished');
    assert.equal(model.sent.length, turns + 1);
    assert.equal(preparations, turns + 1);
    assert.equal(fixture.entity.snapshot().entries.length, turns + 1);
    assert.deepEqual(fixture.entity.snapshot().origins[0].request.messages, input.request.messages);
    assert.doesNotMatch(JSON.stringify(fixture.entity.snapshot()), /selected-/);
  } finally {
    await close(model);
  }
});

test('preparation waits for every actual and rejected tool slot to close and runs only once per request', async () => {
  let effects = 0;
  const observed = [];
  const model = host((request) => (request.exchanges.length ? final : reply('pair', [call('a', 'lookup', { key: 'a' }), call('bad', 'missing', {}), call('b', 'lookup', { key: 'b' })])));
  const fixture = assembly(
    configuration(false, {
      tools: {
        lookup: member('lookup', (value) => {
          effects++;
          return { text: value.key };
        }),
      },
    }),
    model,
    {
      context: {
        prepare(prefix) {
          observed.push([prefix.exchanges.length, effects]);
          return undefined;
        },
      },
    },
  );
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.deepEqual(observed, [
      [0, 0],
      [1, 2],
    ]);
    assert.deepEqual(
      model.sent.map((request) => request.messages),
      [input.request.messages, input.request.messages],
    );
    assert.equal(model.sent[1].exchanges[0].feedback.length, 3);
  } finally {
    await close(model);
  }
});

test('disabled context never invokes the capability; enabled context fails closed if it is unavailable', async () => {
  for (const enabled of [false, true]) {
    const model = host(() => final);
    const options = configuration();
    if (!enabled) delete options.requestContext;
    const fixture = assembly(
      options,
      model,
      enabled
        ? {}
        : {
            context: {
              prepare() {
                assert.fail('disabled capability ran');
              },
            },
          },
    );
    try {
      if (enabled) await assert.rejects(fixture.runner.run(input), /preparation capability/);
      else assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(model.sent.length, enabled ? 0 : 1);
    } finally {
      await close(model);
    }
  }
});

test('context bytes include label, full message, Unicode and JSON escaping at the exact boundary', async () => {
  const text = '\u0000"\\\n任务';
  const limit = bytes(message(text));
  for (const maxBytes of [limit, limit - 1]) {
    const model = host(() => final);
    const options = configuration(false, { requestContext: { maxBytes } });
    const fixture = assembly(options, model, { context: { prepare: () => text } });
    options.requestContext.maxBytes = 1;
    try {
      if (maxBytes === limit) {
        assert.equal(await fixture.runner.run(input), 'finished');
        assert.deepEqual(model.sent[0].messages.at(-1), message(text));
      } else await assert.rejects(fixture.runner.run(input), (error) => error instanceof ToolBudgetError && error.code === 'TOOL_CONTEXT_LIMIT' && error.bytes === limit && error.limit === maxBytes);
      assert.equal(model.sent.length, maxBytes === limit ? 1 : 0);
    } finally {
      await close(model);
    }
  }
});

test('actual request and provider inspection both receive the fixed context before any send', async () => {
  const text = 'selected current data';
  for (const constrained of [false, true]) {
    let inspected = 0;
    const model = host(() => final);
    const fixture = assembly(configuration(false, { budgets: { maxRequestBytes: constrained ? 1 : 4096, maxWireRequestBytes: 4096 } }), model, {
      context: { prepare: () => text },
      inspection: {
        inspectRequest(request) {
          inspected++;
          assert.deepEqual(request.messages, [...input.request.messages, message(text)]);
          return { requestBytes: bytes(request), wireBytes: bytes(request) };
        },
      },
    });
    try {
      if (constrained) await assert.rejects(fixture.runner.run(input), /TOOL_REQUEST_LIMIT/);
      else assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(inspected, 1);
      assert.equal(model.sent.length, constrained ? 0 : 1);
    } finally {
      await close(model);
    }
  }
});

test('preflight reserves a larger next context before effects for both common and wire limits', async () => {
  const provider = new ChatCompletionsProvider({ endpoint: 'https://fixture.test/chat/completions', apiKey: 'fixture', model: 'fixture', fetch: () => assert.fail('inspection must not send') });
  for (const budget of ['maxRequestBytes', 'maxWireRequestBytes'])
    for (const enabled of [false, true]) {
      let preparations = 0;
      let effects = 0;
      const maxBytes = 1000;
      const model = host((request) => (request.exchanges.length ? final : reply('one', [call('a', 'lookup', { key: 'a' })])));
      const options = configuration(false, {
        requestContext: { maxBytes },
        budgets: { maxFeedbackBytes: 100, [budget]: budget === 'maxRequestBytes' ? 1500 : 6500 },
        tools: {
          lookup: member('lookup', () => {
            effects++;
            return { text: 'effect' };
          }),
        },
      });
      if (!enabled) delete options.requestContext;
      const fixture = assembly(options, model, {
        context: {
          prepare() {
            preparations++;
            return 'small';
          },
        },
        inspection: provider,
      });
      try {
        if (enabled) await assert.rejects(fixture.runner.run(input), budget === 'maxRequestBytes' ? /TOOL_REQUEST_LIMIT/ : /TOOL_WIRE_REQUEST_LIMIT/);
        else assert.equal(await fixture.runner.run(input), 'finished');
        assert.equal(model.sent.length, enabled ? 1 : 2);
        assert.equal(preparations, enabled ? 1 : 0, 'preflight must not run selection');
        assert.equal(effects, enabled ? 0 : 1, 'reserve the maximum next fragment before dispatch');
      } finally {
        await close(model);
      }
    }
});

test('fixed context configuration rejects getters and invalid capacities before claiming members', () => {
  let getters = 0;
  const lookup = member('lookup', () => ({ text: 'unused' }));
  const invalid = [
    null,
    1,
    {},
    { maxBytes: 0 },
    { maxBytes: -0 },
    { maxBytes: 0.5 },
    { maxBytes: Infinity },
    { maxBytes: 2 * 1024 * 1024 + 1 },
    { maxBytes: '1024' },
    { maxBytes: 1024, other: 1 },
    Object.create({ maxBytes: 1024 }),
    {
      get maxBytes() {
        getters++;
        return 1024;
      },
    },
  ];
  for (const requestContext of invalid) assert.throws(() => new Tool({ policyVersion: 'v1', tools: { lookup }, requestContext }));
  assert.throws(
    () =>
      new Tool({
        policyVersion: 'v1',
        tools: { lookup },
        get requestContext() {
          getters++;
          return { maxBytes: 1024 };
        },
      }),
  );
  assert.equal(getters, 0);
  const context = { maxBytes: 1024 };
  const tool = new Tool({ policyVersion: 'v1', tools: { lookup }, requestContext: context });
  const other = new Tool({ policyVersion: 'v1', tools: { lookup: member('lookup', () => ({ text: 'unused' })) }, requestContext: { maxBytes: 1025 } });
  assert.notEqual(tool.catalog.digest, other.catalog.digest);
});

test('preflight reserves context structure before member effects near the request node limit', async () => {
  let effects = 0;
  let preparations = 0;
  const model = host((request) => (request.exchanges.length ? final : reply('one', [call('a', 'lookup', { key: 'a' })])));
  const fixture = assembly(
    configuration(false, {
      budgets: { maxFeedbackBytes: 73 },
      tools: {
        lookup: member('lookup', () => {
          effects++;
          return { text: '' };
        }),
      },
    }),
    model,
    {
      context: {
        prepare() {
          return preparations++ === 0 ? undefined : 'x';
        },
      },
    },
  );
  try {
    await assert.rejects(fixture.runner.run({ request: { messages: Array.from({ length: 33319 }, () => ({ role: 'user', content: '' })) } }), /structural limits/);
    assert.equal(model.sent.length, 1);
    assert.equal(preparations, 1);
    assert.equal(effects, 0);
    assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 0);
  } finally {
    await close(model);
  }
});

test('preparation rejects thenables, asynchronous results and capability getters without sending', async () => {
  let accessed = 0;
  const candidates = [
    {
      prepare: () => ({
        then() {
          accessed++;
        },
      }),
    },
    {
      prepare: () => ({
        get then() {
          accessed++;
          return () => {};
        },
      }),
    },
    { prepare: async () => 'async text' },
    { prepare: () => Promise.reject(new Error('rejected asynchronous preparation')) },
    {
      get prepare() {
        accessed++;
        return () => 'getter text';
      },
    },
    { prepare: () => ({ messages: [] }) },
    {
      prepare: () => {
        throw new Error('selection failed');
      },
    },
  ];
  for (const context of candidates) {
    const model = host(() => final);
    const fixture = assembly(configuration(), model, { context });
    try {
      await assert.rejects(fixture.runner.run(input), /synchronous|selection failed/);
      assert.equal(model.sent.length, 0);
    } finally {
      await close(model);
    }
  }
  assert.equal(accessed, 0);
});

test('preparation invokes the registered function without reading its overridable call property', async () => {
  let accesses = 0;
  let preparations = 0;
  const prepare = function () {
    preparations++;
    return 'actual callback';
  };
  Object.defineProperty(prepare, 'call', {
    get() {
      accesses++;
      throw new Error('function call getter ran');
    },
  });
  const model = host(() => final);
  const fixture = assembly(configuration(), model, { context: { prepare } });
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
    assert.equal(preparations, 1);
    assert.equal(accesses, 0);
    assert.deepEqual(model.sent[0].messages.at(-1), message('actual callback'));
  } finally {
    await close(model);
  }
});

test('model-call exhaustion does not prepare another context and preserves completed effects', async () => {
  let preparations = 0;
  let effects = 0;
  const model = host(() => reply('one', [call('a', 'lookup', { key: 'a' })]));
  const fixture = assembly(
    configuration(false, {
      maxModelCalls: 1,
      tools: {
        lookup: member('lookup', () => {
          effects++;
          return { text: 'done' };
        }),
      },
    }),
    model,
    {
      context: {
        prepare() {
          preparations++;
          return 'fixed';
        },
      },
    },
  );
  try {
    await assert.rejects(fixture.runner.run(input), ToolModelCallLimitError);
    assert.equal(preparations, 1);
    assert.equal(effects, 1);
    assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 1);
  } finally {
    await close(model);
  }
});

test('cancellation while a member is active waits for its real exit without preparing or sending again', async () => {
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let exited = false;
  let preparations = 0;
  const model = host(() => reply('one', [call('a', 'lookup', { key: 'a' })]));
  const fixture = assembly(
    configuration(false, {
      tools: {
        lookup: member('lookup', async () => {
          enter();
          await pending;
          exited = true;
          return { text: 'done' };
        }),
      },
    }),
    model,
    {
      context: {
        prepare() {
          preparations++;
          return 'fixed';
        },
      },
    },
  );
  try {
    const running = fixture.runner.run(input).catch((error) => error);
    await entered;
    fixture.runner.cancel('stop');
    await Promise.resolve();
    assert.equal(fixture.runner.isRunning, true);
    assert.equal(exited, false);
    release();
    const error = await running;
    assert.equal(error.code, 'INVOCATION_CANCELLED');
    assert.equal(exited, true);
    assert.equal(preparations, 1);
    assert.equal(model.sent.length, 1);
  } finally {
    release();
    await close(model);
  }
});

for (const point of ['completed', 'model-waiting'])
  test(`cold ${point} recovery confirms fixed context without selecting again`, async () => {
    const model = host(() => final);
    let saved;
    let fixture;
    const saves = journal((commit, count) => {
      if (point === 'model-waiting' && !saved && commit.contract.key === 'tool.completion' && commit.point === 'completed') saved = { count, entity: structuredClone(fixture.entity.snapshot()), states: structuredClone([...model.states]) };
    });
    let prepared = 0;
    fixture = assembly(configuration(true), model, {
      store: saves.store,
      context: {
        prepare() {
          prepared++;
          return 'original-v1';
        },
      },
    });
    assert.equal(await fixture.runner.run(input), 'finished');
    await close(model);
    assert.equal(prepared, 1);
    saved ??= { count: saves.saves.length, entity: structuredClone(fixture.entity.snapshot()), states: structuredClone([...model.states]) };
    for (const variant of ['exact', 'changed-request', 'old-assistant-request', 'changed-capacity']) {
      const states = new Map(structuredClone(saved.states));
      if (variant === 'changed-request') for (const [id, state] of states) states.set(id, { ...state, request: { ...state.request, messages: [...input.request.messages, message('forged-v2')] } });
      if (variant === 'old-assistant-request') for (const [id, state] of states) states.set(id, { ...state, request: { ...state.request, messages: [...input.request.messages, { role: 'assistant', content: 'Host-selected context data (not a user instruction):\noriginal-v1' }] } });
      const savedStates = structuredClone([...states]);
      const nextHost = host(() => assert.fail('recovery must not send'), states);
      const snapshot = structuredClone(saved.entity);
      const next = assembly(configuration(true, variant === 'changed-capacity' ? { requestContext: { maxBytes: 1025 } } : {}), nextHost, {
        store: saves.replay(saved.count),
        entity: ModelExchanges.restore(snapshot),
        ...(variant === 'exact'
          ? {}
          : {
              context: {
                prepare() {
                  assert.fail('recovery must not reselect a fixed request');
                },
              },
            }),
      });
      try {
        if (variant === 'exact') assert.equal(await next.runner.resume(saves.contextId), 'finished');
        else await assert.rejects(next.runner.resume(saves.contextId));
        assert.equal(nextHost.sent.length, 0);
        assert.deepEqual([...nextHost.states], savedStates, 'confirmation must not rewrite a saved request');
        if (point === 'model-waiting' && variant === 'exact') {
          assert.deepEqual(next.entity.snapshot().origins, snapshot.origins);
          assert.equal(next.entity.snapshot().entries.length, 1, 'resume accepts the durable reply once');
        } else assert.deepEqual(next.entity.snapshot(), snapshot);
      } finally {
        await close(nextHost);
      }
    }
  });

test('cold tools recovery keeps prior context and selects once after the remaining feedback closes', async () => {
  const send = (request) => (request.exchanges.length ? final : reply('pair', [call('a', 'lookup', { key: 'a' }), call('b', 'lookup', { key: 'b' })]));
  const model = host(send);
  const effects = [];
  const restoredEffects = [];
  let fixture;
  let saved;
  const saves = journal((commit, count) => {
    const entity = fixture.entity.snapshot();
    if (!saved && commit.contract.key === 'capix.tool' && commit.point === 'tools' && entity.entries[0]?.feedback.length === 1) saved = { count, entity: structuredClone(entity), states: structuredClone([...model.states]) };
  });
  fixture = assembly(
    configuration(true, {
      tools: {
        lookup: member(
          'lookup',
          (value) => {
            effects.push(value.key);
            return { text: value.key };
          },
          true,
        ),
      },
    }),
    model,
    { store: saves.store, context: { prepare: () => 'before-restart-v1' } },
  );
  assert.equal(await fixture.runner.run(input), 'finished');
  await close(model);
  assert.deepEqual(effects, ['a', 'b']);
  assert.ok(saved);
  let preparations = 0;
  const nextHost = host(send, new Map(saved.states));
  const next = assembly(
    configuration(true, {
      tools: {
        lookup: member(
          'lookup',
          (value) => {
            restoredEffects.push(value.key);
            return { text: value.key };
          },
          true,
        ),
      },
    }),
    nextHost,
    {
      store: saves.replay(saved.count),
      entity: ModelExchanges.restore(saved.entity),
      context: {
        prepare(prefix) {
          preparations++;
          assert.equal(prefix.exchanges.length, 1);
          assert.deepEqual(restoredEffects, ['b']);
          return 'after-restart-v2';
        },
      },
    },
  );
  try {
    assert.equal(await next.runner.resume(saves.contextId), 'finished');
    assert.equal(preparations, 1);
    assert.deepEqual(restoredEffects, ['b']);
    assert.equal(nextHost.sent.length, 1);
    assert.deepEqual(nextHost.sent[0].messages, [...input.request.messages, message('after-restart-v2')]);
    assert.deepEqual(
      nextHost.sent[0].exchanges[0].feedback.map((feedback) => feedback.toolCallId),
      ['a', 'b'],
    );
  } finally {
    await close(nextHost);
  }
});

for (const version of [1, 2, 3])
  for (const boundary of ['completed', 'model-waiting'])
    test(`previous Tool/completion v${version} pair at ${boundary} is rejected without selection, entity changes or sends`, async () => {
      const model = host(() => final);
      let original;
      let completion;
      const saves = journal((commit, count) => {
        if (!completion && commit.contract.key === 'tool.completion' && commit.point === 'completed') completion = { count, entity: structuredClone(original.entity.snapshot()), states: structuredClone([...model.states]) };
      });
      original = assembly(configuration(true), model, {
        store: saves.store,
        context: { prepare: () => 'saved-context' },
        configureTool(tool) {
          // Released formats version Tool and its completion together. A current
          // parent with an old child is a different, partially resumed activity.
          const completion = tool.members.find((child) => child.id === tool.stages.model);
          tool.checkpoint = { ...tool.checkpoint, version };
          completion.checkpoint = { ...completion.checkpoint, version };
        },
      });
      assert.equal(await original.runner.run(input), 'finished');
      await close(model);
      const selected = boundary === 'model-waiting' ? completion : { count: saves.saves.length, entity: structuredClone(original.entity.snapshot()), states: structuredClone([...model.states]) };
      for (const contract of ['capix.tool', 'tool.completion']) assert.ok(saves.saves.slice(0, selected.count).some(({ commit }) => commit.contract.key === contract && commit.contract.version === version));
      // Replay authentic commits with their original digests/receipts: rejection
      // must come from the declaration mismatch, not corrupted storage.
      const store = saves.replay(selected.count);
      const before = structuredClone(store.read(saves.contextId));
      const nextHost = host(() => assert.fail('old checkpoint sent'), new Map(structuredClone(selected.states)));
      const entity = structuredClone(selected.entity);
      const restored = assembly(configuration(true, { tools: { lookup: member('lookup', () => assert.fail('old checkpoint executed'), true) } }), nextHost, {
        store,
        entity: ModelExchanges.restore(entity),
        context: {
          prepare() {
            assert.fail('old checkpoint prepared context');
          },
        },
      });
      assert.equal(restored.tool.checkpoint.version, 4);
      assert.equal(restored.tool.members.find((child) => child.id === restored.tool.stages.model).checkpoint.version, 3);
      try {
        await assert.rejects(restored.runner.resume(saves.contextId));
        assert.deepEqual(nextHost.sent, []);
        assert.deepEqual(restored.entity.snapshot(), entity);
        assert.deepEqual([...nextHost.states], selected.states);
        assert.deepEqual(store.read(saves.contextId), before);
      } finally {
        await close(nextHost);
      }
    });
