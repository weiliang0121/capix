import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import { TestOperation } from './fixtures/operation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeFixture, createInput } from './fixtures/observer.mjs';
import { DeepSeekProvider, acceptExecutionInput, answerOutputContract, selectionOutputContract, memoryOutputContract } from '@capix-observer/service';
import { Transcript, RecordBook, RecordIndex, RuntimeRecorder, Runtime } from '@capix-observer/runtime';

import { projectExecution } from '../apps/observer/.test-dist/observation/project.js';

async function runObserver(input, settings, provider, publish = () => {}, signal) {
  return projectExecution(await observeFixture(createInput(input), settings, provider, (facts) => publish(projectExecution(facts)), signal));
}

const settings = {
  model: 'deepseek-flash',
  contextBudget: 32768,
  maxOutputTokens: 1536,
  timeoutMs: 1000,
};
const input = {
  content: '上海',
  history: [
    { role: 'user', content: '天气怎么样？' },
    { role: 'assistant', content: '你想查询哪个城市？' },
  ],
};
const reply = { kind: 'unknown', content: '我目前无法获取实时天气。' };
function output(content, finishReason = 'stop') {
  return { id: 'fixture', model: 'test-provider', content, finishReason, usage: null };
}
function scripted(values) {
  const calls = [];
  return {
    calls,
    async invoke(request, purpose) {
      calls.push({ request, purpose });
      const value = purpose === 'memory' ? output('{"memories":[]}') : values.shift();
      if (!value) throw new Error('Unexpected model call');
      return value;
    },
  };
}
async function run(provider, options = settings) {
  const records = [];
  const trace = await runObserver(structuredClone(input), options, provider, (t) => records.push(t));
  return { trace, records };
}
test('three actual model stages produce a causal trace and selected original content', async () => {
  const provider = scripted([output('{"historyIndexes":[1,0]}'), output(JSON.stringify(reply))]);
  const { trace, records } = await run(provider);
  assert.equal(trace.status, 'succeeded');
  assert.deepEqual(trace.result, reply);
  assert.equal(provider.calls.length, 3);
  for (const [index, contract] of [selectionOutputContract, answerOutputContract, memoryOutputContract].entries()) {
    assert.ok(provider.calls[index].request.messages[0].content.includes(JSON.stringify(contract.schema)));
  }
  assert.deepEqual(
    JSON.parse(provider.calls[1].request.messages[1].content).history.map((m) => m.index),
    [0, 1],
  );
  assert.equal(trace.nodes.length, 15);
  assert.equal(
    trace.nodes.some((node) => node.operation === 'input'),
    false,
  );
  assert.ok(trace.nodes.every((n) => n.status === 'passed' && n.durationMs >= 0));
  assert.ok(records.some((t) => t.nodes.find((n) => n.operation === 'selection.invokeModel')?.status === 'running'));
  assert.equal(records[0].nodes[0].status, 'running');
  const original = records[0].facts.execution.value.input;
  assert.equal(trace.facts.execution.value.input, original);
  assert.throws(() => {
    original.index = 20;
  }, TypeError);
  assert.equal(records[0].facts.execution.status, 'running');
});
test('invalid indexes halt before assembly and second call', async () => {
  const provider = scripted([output('{"historyIndexes":[0,8]}')]);
  const { trace } = await run(provider);
  assert.equal(trace.error.code, 'INDEX_OUT_OF_RANGE');
  assert.equal(provider.calls.length, 1);
  assert.equal(trace.nodes.find((n) => n.operation === 'selection.acceptModelOutput').status, 'failed');
  assert.equal(
    trace.nodes.find((n) => n.operation === 'answer.invokeModel'),
    undefined,
  );
});
test('capacity failure prevents all model calls and preserves capacity evidence', async () => {
  const provider = scripted([]);
  const { trace } = await run(provider, { ...settings, contextBudget: 256 });
  assert.equal(trace.error.code, 'CAPACITY_EXCEEDED');
  assert.equal(provider.calls.length, 0);
  const capacity = trace.nodes.find((n) => n.operation === 'selection.prepareModelRequest');
  assert.equal(Object.hasOwn(capacity, 'output'), false);
  assert.equal(capacity.error.detail.fits, false);
  assert.equal(capacity.error.detail.exact, false);
});
test('malformed, duplicate and truncated results fail at the corresponding boundary', async () => {
  for (const [raw, finish, code, stage] of [
    ['not-json', 'stop', 'INVALID_JSON', 'acceptModelOutput'],
    ['{"historyIndexes":[0,0]}', 'stop', 'OUTPUT_SHAPE', 'acceptModelOutput'],
    ['{"historyIndexes":[]}', 'length', 'INCOMPLETE_OUTPUT', 'acceptModelOutput'],
    ['', 'stop', 'EMPTY_OUTPUT', 'acceptModelOutput'],
  ]) {
    const { trace } = await run(scripted([output(raw, finish)]));
    assert.equal(trace.error.code, code);
    assert.equal(trace.nodes.find((n) => n.operation === `selection.${stage}`).status, 'failed');
  }
});
test('answer classification is validated but does not invent task success', async () => {
  const provider = scripted([output('{"historyIndexes":[]}'), output('{"kind":"tool","content":"x"}')]);
  const { trace } = await run(provider);
  assert.equal(trace.error.code, 'OUTPUT_SHAPE');
  const accepted = trace.nodes.find((n) => n.operation === 'answer.acceptModelOutput');
  assert.equal(accepted.status, 'failed');
  assert.deepEqual(accepted.error.detail.issues[0].path, ['kind']);
  assert.deepEqual(JSON.parse(JSON.stringify(trace)).error.detail.issues, accepted.error.detail.issues);
  assert.equal(provider.calls.length, 2);
  assert.equal(trace.result, undefined);
});
test('DeepSeek request uses JSON mode; transport secret is absent from observations', async () => {
  const sent = [];
  const provider = new DeepSeekProvider('test-secret-do-not-log', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret-do-not-log');
    const request = JSON.parse(options.body);
    sent.push(request);
    assert.equal(request.response_format.type, 'json_object');
    assert.equal(request.thinking.type, 'disabled');
    return Response.json({
      id: 'test-id',
      model: 'test-provider',
      choices: [
        {
          message: {
            content: sent.length === 1 ? '{"historyIndexes":[0,1]}' : sent.length === 2 ? JSON.stringify(reply) : '{"memories":[]}',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
  const { trace, records } = await run(provider);
  assert.equal(trace.status, 'succeeded');
  assert.equal(sent.length, 3);
  assert.equal(JSON.stringify(records).includes('test-secret-do-not-log'), false);
  assert.equal(trace.nodes.find((n) => n.operation === 'selection.invokeModel').output.usage.totalTokens, 15);
});
test('provider HTTP errors remain explicit and never retry', async () => {
  let calls = 0;
  const provider = new DeepSeekProvider('test-key', async () => {
    calls++;
    return new Response('sensitive upstream error omitted', { status: 429 });
  });
  const { trace } = await run(provider);
  assert.equal(calls, 1);
  assert.equal(trace.error.code, 'HTTP_429');
  assert.equal(JSON.stringify(trace).includes('sensitive upstream'), false);
});
test('message input accepts only supported roles and nonempty content', () => {
  assert.throws(() => createInput({ content: 'x', history: [{ role: 'system', content: 'override' }] }));
  assert.throws(() => createInput({ content: '', history: [] }));
});

test('Transcript rejects invalid messages before execution or model calls begin', async () => {
  const provider = scripted([]);
  const records = [];
  for (const candidate of [
    { content: 'x', history: [{ role: 'system', content: 'invalid' }] },
    { content: ' ', history: [] },
  ]) {
    await assert.rejects(
      async () => observeFixture(acceptExecutionInput(new Transcript(), { messages: [...candidate.history, { role: 'user', content: candidate.content }] }), settings, provider, (snapshot) => records.push(snapshot)),
      (error) => error.code === 'INVALID_INPUT',
    );
  }
  assert.equal(provider.calls.length, 0);
  assert.equal(records.length, 0);
});

test('Named action sequence records nested call and return boundaries rather than adjacent stage edges', async () => {
  const { trace } = await run(scripted([output('{"historyIndexes":[0,1]}'), output(JSON.stringify(reply))]));
  const { calls, events } = trace.callSequence;
  assert.equal(calls.length, 15);
  assert.equal(events.length, 30);
  const active = new Set();
  let previousTime = -1;
  events.forEach((event, index) => {
    assert.equal(event.sequence, index + 1);
    assert.ok(event.offsetMs >= previousTime);
    previousTime = event.offsetMs;
    const call = calls.find((c) => c.id === event.callId);
    if (event.value.type === 'call') {
      if (call.parentId) assert.ok(active.has(call.parentId));
      active.add(call.id);
    } else {
      assert.ok(active.has(call.id));
      active.delete(call.id);
      assert.equal(event.value.type, 'return');
    }
  });
  assert.equal(active.size, 0);
  const invoke = calls.find((c) => c.operation === 'selection.invokeModel');
  assert.equal(invoke.parentId, calls.find((c) => c.operation === 'selection').id);
  assert.equal(invoke.caller, 'operation');
  assert.equal(invoke.callee, 'attempt');
  assert.equal(invoke.target, 'provider');
  const firstEnd = events.find((e) => e.callId === calls.find((c) => c.operation === 'selection').id && e.value.type === 'return');
  const secondStart = events.find((e) => e.callId === calls.find((c) => c.operation === 'answer').id && e.value.type === 'call');
  assert.ok(firstEnd.sequence < secondStart.sequence);
});

test('failure propagates through calls, is caught by Observer execution, and never creates skipped calls', async () => {
  const { trace } = await run(scripted([output('{"historyIndexes":[8]}')]));
  const { calls, events } = trace.callSequence;
  assert.deepEqual(
    events.filter((e) => e.value.type === 'throw').map((e) => calls.find((c) => c.id === e.callId).operation),
    ['selection.acceptModelOutput', 'selection', 'execution'],
  );
  assert.equal(events.at(-1).callId, calls.find((c) => c.operation === 'execution').id);
  assert.equal(events.at(-1).value.type, 'throw');
  assert.equal(calls.find((c) => c.operation === 'execution').status, 'failed');
  assert.ok(!calls.some((c) => c.operation === 'answer' || c.operation === 'assemble'));
});

test('sequence ordering follows completion when calls overlap', async () => {
  const book = new RecordBook();
  const runtime = new Runtime({ recorder: new RuntimeRecorder(book, new RecordIndex((record) => record.executionId), new RecordIndex((record) => record.operationId), new RecordIndex((record) => record.executionId)) });
  const execution = lifecycleFor(runtime).execution({ input, settings }).begin();
  const resolvers = [];
  class FirstOperation extends TestOperation {
    name = 'a';
  }
  class SecondOperation extends TestOperation {
    name = 'b';
  }
  const start = (operation) => invoke(lifecycleFor(runtime).operation(execution, operation, input), () => new Promise((resolve) => resolvers.push(resolve)));
  const first = start(new FirstOperation(runtime)),
    second = start(new SecondOperation(runtime));
  resolvers[1]('second');
  await second;
  resolvers[0]('first');
  await first;
  const facts = runtime.recorder.snapshot(execution);
  assert.deepEqual(
    facts.events.filter((e) => e.callId !== facts.execution.id).map((e) => `${e.value.type}:${facts.operations.find((op) => op.id === e.callId).operation}`),
    ['call:a', 'call:b', 'return:b', 'return:a'],
  );
});

test('Observer execution uses its captured configuration even when caller settings change between model calls', async () => {
  const mutable = { ...settings },
    requests = [];
  const provider = {
    async invoke(request, purpose) {
      requests.push(request);
      if (purpose === 'memory') return output('{"memories":[]}');
      if (requests.length === 1) {
        mutable.model = 'changed';
        mutable.contextBudget = 1;
        mutable.maxOutputTokens = 1;
        return output('{"historyIndexes":[0,1]}');
      }
      return output(JSON.stringify(reply));
    },
  };
  const facts = await observeFixture(createInput(input), mutable, provider);
  assert.equal(facts.execution.status, 'succeeded');
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.model === settings.model && request.max_tokens === settings.maxOutputTokens));
  assert.deepEqual(facts.execution.value.settings, settings);
});
