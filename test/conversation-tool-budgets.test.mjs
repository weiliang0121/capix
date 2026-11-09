import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Node, Scene, checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ChatCompletionsProvider, requireModelReply, requireModelRequest } from '@weiliang0121/capix-model-provider';
import { tool, createToolLoop, registerToolLoopResources, resolveToolBudgets, assertToolReplyBytes, assertToolFeedbackBytes, assertToolOutputBytes, assertToolRequestBytes, ToolBudgetError } from '@capix/conversation-service/tools';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const result = (text, status = 'ok') => ({ status, content: [{ kind: 'text', text }] });
const calls = (names = ['read']) => names.map((name, index) => ({ kind: 'tool-call', id: `call-${index}`, name, arguments: { encoding: 'json-text', text: '{}' } }));
function reply(output, reason = 'stop') {
  return requireModelReply({ formatVersion: 1, id: 'reply', model: 'fixture', output, termination: { kind: 'completed', reason }, usage: null, native: { format: 'chat-completions', version: 1 } });
}
const done = () => reply([{ kind: 'text', text: 'done' }]);
const model = (request) => (request.exchanges.length ? done() : reply(calls(), 'tool_calls'));
const contract = { key: 'test.tools.budget', request: requireModelRequest, reply: requireModelReply };
const textCodec = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
class Journal extends MemoryCheckpointStore {
  images = [];
  save(image, revision) {
    const saved = super.save(image, revision);
    this.images.push(structuredClone(image));
    return saved;
  }
}
function harness({ budgets, maxOutputBytes, selfCheck = false, output = 'small', mapped, failed, failure, nextModel = model, inspection, checkpoint = true } = {}) {
  let executions = 0;
  let mappings = 0;
  const completed = checkpointPoint()({ name: 'done', state: textCodec, references: {}, resume: { run: (_work, value) => value } });
  const node = new Node({
    ...(checkpoint ? { checkpoint: { key: 'test.tool.budget', version: 1, input: { encode: (value) => value, decode: (value) => value }, output: textCodec, points: [completed] } } : {}),
    run(work) {
      executions++;
      if (failure) throw failure;
      if (selfCheck) assertToolOutputBytes(output, maxOutputBytes);
      work.checkpoint?.({ point: completed, state: output, refs: {} });
      return output;
    },
  });
  const registered = tool(node, {
    description: 'A fixture tool',
    input: z.strictObject({}),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    result: {
      succeeded(value) {
        mappings++;
        return mapped ?? result(value);
      },
      ...(failed ? { failed } : {}),
    },
  });
  const loop = createToolLoop({ tools: { read: registered }, policyVersion: 'budget-v1', checkpoint, budgets });
  const requests = [];
  const persisted = new Map();
  const interactions = new Interactions().register(contract, {
    send(request) {
      requests.push(request);
      return nextModel(request);
    },
    persistence: {
      read: (id) => persisted.get(id),
      create(state) {
        persisted.set(state.id, structuredClone(state));
      },
      commit({ state }) {
        persisted.set(state.id, structuredClone(state));
      },
    },
  });
  const exchanges = new ModelExchanges();
  const resources = new Resources();
  registerToolLoopResources(resources, loop, exchanges, interactions.bind(contract), { read: (id) => persisted.get(id) }, inspection);
  const checkpoints = new Journal();
  const runner = new Runner(new Scene(loop), resources, interactions, { checkpoints: { store: checkpoints } }).build();
  return {
    loop,
    runner,
    exchanges,
    requests,
    checkpoints,
    get executions() {
      return executions;
    },
    get mappings() {
      return mappings;
    },
    input: () => loop.input({ messages: [{ role: 'user', content: 'hello' }] }, 'budget-scope'),
    async close() {
      await interactions.settled();
      interactions.close();
    },
  };
}

test('byte budgets measure complete protocol JSON and retain immutable configuration', () => {
  const configuration = { maxFeedbackBytes: 300 };
  const budgets = resolveToolBudgets(configuration);
  configuration.maxFeedbackBytes = 900;
  assert.equal(budgets.maxFeedbackBytes, 300);
  assert.throws(() => {
    budgets.maxFeedbackBytes = 900;
  }, TypeError);
  const value = result('\u0000"\\汉😀');
  const full = { toolCallId: 'long-identity', ...value };
  const exact = resolveToolBudgets({ maxFeedbackBytes: bytes(full) });
  assert.equal(assertToolFeedbackBytes(full.toolCallId, value, exact), value);
  assert.throws(() => assertToolFeedbackBytes(full.toolCallId, value, { ...exact, maxFeedbackBytes: bytes(full) - 1 }), /TOOL_FEEDBACK_LIMIT/);
  assert.throws(() => assertToolFeedbackBytes(' ', value, exact), /identity/);
  assert.throws(() => resolveToolBudgets({ maxFeedbackBytes: 0 }), /Invalid/);
  assert.throws(() => resolveToolBudgets({ unknown: 1 }), /Unknown/);
  assert.throws(() => assertToolReplyBytes(done(), resolveToolBudgets({ maxReplyBytes: 1 })), /TOOL_REPLY_LIMIT/);
  assert.throws(() => assertToolOutputBytes({ large: 'x'.repeat(8 * 1024 * 1024 + 1) }, 100), ToolBudgetError);
  let evaluated = 0;
  assert.throws(
    () =>
      assertToolOutputBytes(
        {
          get unsafe() {
            evaluated++;
            return 'x';
          },
        },
        100,
      ),
    /accessors/,
  );
  assert.equal(evaluated, 0);
  const repeated = { text: '\u0000汉' };
  const output = [repeated, repeated];
  assert.equal(assertToolOutputBytes(output, bytes(output)), output);
  assert.throws(() => assertToolOutputBytes(output, bytes(output) - 1), ToolBudgetError);
});

test('ToolLoop rejects oversized model reply before completed CP or entity intake', async () => {
  const h = harness({ budgets: { maxReplyBytes: 500 }, nextModel: () => reply([{ kind: 'text', text: 'x'.repeat(1000) }]) });
  try {
    await assert.rejects(h.runner.run(h.input()), /TOOL_REPLY_LIMIT/);
    assert.equal(h.executions, 0);
    assert.equal(h.exchanges.values().length, 0);
    assert.equal(
      h.checkpoints.images.some((image) => image.contract.key === 'conversation.tools.completion' && image.point === 'completed'),
      false,
    );
  } finally {
    await h.close();
  }
});

test('next-request feedback reservation rejects before the first tool is dispatched', async () => {
  const h = harness({ budgets: { maxRequestBytes: 700, maxFeedbackBytes: 512 } });
  try {
    await assert.rejects(h.runner.run(h.input()), /TOOL_REQUEST_LIMIT/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.executions, 0);
    assert.equal(h.exchanges.values()[0].feedback.length, 0);
  } finally {
    await h.close();
  }
});

test('collection reservation includes feedback receipts before tool side effects', async () => {
  const h = harness({ budgets: { maxReplyBytes: 1000, maxCollectionBytes: 30_000 }, nextModel: () => reply(calls(['read', 'read']), 'tool_calls') });
  try {
    await assert.rejects(h.runner.run(h.input()), /TOOL_COLLECTION_LIMIT/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.executions, 0);
  } finally {
    await h.close();
  }
});

test('actual mapped feedback and precheck rejection have the same byte limit', async () => {
  for (const unknown of [false, true]) {
    const h = harness({ budgets: { maxFeedbackBytes: 90 }, mapped: result('x'.repeat(500)), nextModel: () => reply(calls([unknown ? 'unknown' : 'read']), 'tool_calls') });
    try {
      await assert.rejects(h.runner.run(h.input()), /TOOL_FEEDBACK_LIMIT/);
      assert.equal(h.executions, unknown ? 0 : 1);
      assert.equal(h.exchanges.values()[0].feedback.length, 0);
      assert.equal(h.requests.length, 1);
    } finally {
      await h.close();
    }
  }
});

test('declared raw output bound is checked by parent; only the tool can enforce before its CP', async () => {
  for (const selfCheck of [false, true]) {
    const h = harness({ maxOutputBytes: 10, selfCheck, output: 'x'.repeat(50) });
    try {
      await assert.rejects(h.runner.run(h.input()), /TOOL_OUTPUT_LIMIT/);
      assert.equal(h.executions, 1);
      assert.equal(h.mappings, 0);
      assert.equal(
        h.checkpoints.images.some((image) => image.contract.key === 'test.tool.budget'),
        !selfCheck,
      );
    } finally {
      await h.close();
    }
  }
});

test('a tool-owned budget failure terminates the loop without invoking business failed mapping', async () => {
  let mapped = 0;
  const h = harness({
    maxOutputBytes: 10,
    selfCheck: true,
    output: 'x'.repeat(50),
    failed() {
      mapped++;
      return result('short replacement');
    },
  });
  try {
    await assert.rejects(h.runner.run(h.input()), /TOOL_OUTPUT_LIMIT/);
    assert.equal(mapped, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.exchanges.values()[0].feedback.length, 0);
  } finally {
    await h.close();
  }
});

test('a business error with the same code does not impersonate the preset budget error', async () => {
  let mapped = 0;
  const failure = Object.assign(new Error('ordinary business failure'), { code: 'TOOL_OUTPUT_LIMIT' });
  const h = harness({
    failure,
    failed() {
      mapped++;
      return result('replacement');
    },
  });
  try {
    assert.equal(await h.runner.run(h.input()), 'done');
    assert.equal(mapped, 1);
    assert.equal(h.requests.length, 2);
  } finally {
    await h.close();
  }
});

test('registered raw output budget participates in directory compatibility; input fixes exact collection and budgets', async () => {
  const a = harness({ maxOutputBytes: 100 });
  const b = harness({ maxOutputBytes: 101 });
  try {
    assert.notEqual(a.loop.catalog.digest, b.loop.catalog.digest);
    const input = a.loop.input({ messages: [{ role: 'user', content: 'fixed' }] }, 'scope', a.exchanges.id);
    assert.equal(input.collection, a.exchanges.id);
    assert.deepEqual(input.budgets, a.loop.budgets);
    assert.throws(() => a.loop.checkInput({ ...input, budgets: { ...input.budgets, maxReplyBytes: input.budgets.maxReplyBytes + 1 } }), /budgets changed/);
  } finally {
    await a.close();
    await b.close();
  }
});

test('wire reservation uses the real provider encoder and escaped JSON feedback, without HTTP', () => {
  let sends = 0;
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid/completions',
    apiKey: 'offline',
    model: 'fixture',
    fetch() {
      sends++;
      throw new Error('unexpected HTTP');
    },
  });
  const toolsReply = reply(calls(), 'tool_calls');
  const placeholder = { toolCallId: 'call-0', ...result('') };
  const request = { messages: [{ role: 'user', content: 'hello' }], exchanges: [{ reply: toolsReply, feedback: [placeholder] }] };
  const inspection = provider.inspectRequest(request);
  const actualFeedback = { toolCallId: 'call-0', ...result('\u0000"\\'.repeat(30)) };
  const actual = provider.inspectRequest({ ...request, exchanges: [{ reply: toolsReply, feedback: [actualFeedback] }] });
  const growth = bytes(actualFeedback);
  assert.ok(actual.wireBytes <= inspection.wireBytes + 2 * growth);
  const budgets = resolveToolBudgets({ maxWireRequestBytes: inspection.wireBytes + 2 * growth - 1 });
  assert.throws(() => assertToolRequestBytes(request, budgets, provider, growth), /TOOL_WIRE_REQUEST_LIMIT/);
  assert.equal(sends, 0);
});

test('real provider wire inspection rejects the next request before tool dispatch', async () => {
  let sends = 0;
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid/completions',
    apiKey: 'offline',
    model: 'fixture',
    fetch() {
      sends++;
      throw new Error('unexpected HTTP');
    },
  });
  const h = harness({ budgets: { maxFeedbackBytes: 512, maxWireRequestBytes: 800 }, inspection: provider });
  try {
    await assert.rejects(h.runner.run(h.input()), /TOOL_WIRE_REQUEST_LIMIT/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.executions, 0);
    assert.equal(sends, 0);
  } finally {
    await h.close();
  }
});

test('tool flow accepts escaped feedback within its actual JSON budgets', async () => {
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid/completions',
    apiKey: 'offline',
    model: 'fixture',
    fetch() {
      throw new Error('unexpected HTTP');
    },
  });
  const h = harness({ budgets: { maxFeedbackBytes: 512 }, mapped: result('\u0000"\\'.repeat(20)), inspection: provider });
  try {
    assert.equal(await h.runner.run(h.input()), 'done');
    assert.equal(h.executions, 1);
    assert.equal(h.requests.length, 2);
  } finally {
    await h.close();
  }
});

test('preflight reserves feedback block structure as well as bytes before executing the tool', async () => {
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid/completions',
    apiKey: 'offline',
    model: 'fixture',
    fetch() {
      throw new Error('unexpected HTTP');
    },
  });
  const h = harness({ checkpoint: false, inspection: provider });
  const count = (value) => (value && typeof value === 'object' ? 1 + Object.values(value).reduce((sum, item) => sum + count(item), 0) : 1);
  const exchange = { reply: reply(calls(), 'tool_calls'), feedback: [{ toolCallId: 'call-0', ...result('') }] };
  const minimal = { messages: [], exchanges: [exchange], tools: h.loop.catalog.tools, stream: false, responseFormat: 'text' };
  const messages = Array.from({ length: Math.floor((100_000 - count(minimal)) / 3) }, () => ({ role: 'user', content: '' }));
  const oneBlock = { ...minimal, messages };
  const maximal = { ...oneBlock, exchanges: [{ ...exchange, feedback: [{ toolCallId: 'call-0', status: 'ok', content: Array.from({ length: 32 }, () => ({ kind: 'text', text: '' })) }] }] };
  assert.ok(provider.inspectRequest(oneBlock).wireBytes < 2 * 1024 * 1024);
  assert.throws(() => requireModelRequest(maximal), /structural limits/);
  try {
    await assert.rejects(h.runner.run(h.loop.input({ messages }, 'structure-budget')), /structural limits|invalid, unsupported/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.executions, 0);
    assert.equal(h.exchanges.values()[0].feedback.length, 0);
  } finally {
    await h.close();
  }
});
