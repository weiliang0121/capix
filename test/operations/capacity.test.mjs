import { resourceBindingFor, bindChild } from '../fixtures/observer.mjs';
import { callFor } from '../fixtures/lifecycle.mjs';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import { readOutput } from '@weiliang0121/capix-protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript } from '@weiliang0121/capix-transcript';
import { createBoundRuntime } from '../fixtures/runtime.mjs';

import { GenerateAnswer, estimateCapacity } from '@capix/observer-service';

import { createInput, observeFixture } from '../fixtures/observer.mjs';

const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 256, timeoutMs: 10000 };
const output = (content) => ({ id: 'test', model: 'test', content: JSON.stringify(content), finishReason: 'stop', usage: null });
const message = Object.freeze({ role: 'user', content: '继续解释“它”\n\\' });
const selectedMessages = Object.freeze([Object.freeze({ index: 2, message: Object.freeze({ role: 'user', content: '它是“上海”\n\\🙂' }) }), Object.freeze({ index: 0, message: Object.freeze({ role: 'user', content: '完整的背景。'.repeat(100) }) }), Object.freeze({ index: 1, message: Object.freeze({ role: 'assistant', content: '短' }) })]);
const input = Object.freeze({ message, selectedMessages });
// Independent accounting of the actual serialized request, including nested JSON escaping.
const required = (request) => Buffer.byteLength(JSON.stringify(request), 'utf8') + 256 + request.max_tokens;
const withHistory = (request, indexes) => {
  const body = JSON.parse(request.messages[1].content);
  return { ...request, messages: [request.messages[0], { ...request.messages[1], content: JSON.stringify({ ...body, history: body.history.filter((item) => indexes.includes(item.index)) }) }] };
};

async function generate(input, contextBudget = settings.contextBudget, requests = []) {
  const runtime = createBoundRuntime();
  const provider = {
    async invoke(request) {
      requests.push(request);
      return output({ kind: 'answer', content: '完成' });
    },
  };
  const operation = bindChild(runtime, new GenerateAnswer());
  const resourceBinding = resourceBindingFor(runtime, provider);
  const history = [...selectedMessages].sort((a, b) => a.index - b.index).map((item) => item.message);
  const transcript = new Transcript([...history, input.message]);
  await invoke(lifecycleFor(runtime).execution({ input: transcript.current('user'), transcript, resourceBinding, settings: { ...settings, contextBudget } }), (context) => operation.call(callFor(context), { context: input, memories: [] }));
  return requests[0];
}

test('generation preserves complete active history in its declared order and rejects overflow before model invocation', async () => {
  const full = await generate(input);
  assert.deepEqual(
    JSON.parse(full.messages[1].content).history.map((item) => item.index),
    [2, 0, 1],
  );
  const exactBudget = required(full);
  assert.deepEqual(await generate(input, exactBudget), full);
  assert.equal(estimateCapacity(full, { ...settings, contextBudget: exactBudget }).required, exactBudget);
  const requests = [];
  await assert.rejects(generate(input, exactBudget - 1, requests), (error) => error.code === 'CAPACITY_EXCEEDED' && error.detail.required === exactBudget && error.detail.fits === false);
  assert.equal(requests.length, 0);
  assert.deepEqual(
    input.selectedMessages.map((item) => item.index),
    [2, 0, 1],
  );
});

test('a partial prefix fitting the budget does not authorize dropping the rest of active material', async () => {
  const full = await generate(input);
  const budget = required(withHistory(full, [2]));
  assert.ok(budget < required(full));
  const requests = [];
  await assert.rejects(generate(input, budget, requests), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(requests.length, 0);
});

test('empty active history can fit exactly; fixed request content and output reserve cannot be truncated', async () => {
  const empty = { message, selectedMessages: [] };
  const full = await generate(empty);
  const budget = required(full);
  assert.deepEqual(await generate(empty, budget), full);
  const requests = [];
  await assert.rejects(generate(empty, budget - 1, requests), (error) => error.code === 'CAPACITY_EXCEEDED' && error.detail.reservedOutputTokens === settings.maxOutputTokens);
  assert.equal(requests.length, 0);
});

test('the observed execution uses fixed active material without a selection-model pass', async () => {
  const history = [...selectedMessages].sort((a, b) => a.index - b.index).map((item) => item.message);
  const current = createInput({ content: message.content, history });
  const requests = [];
  const facts = await observeFixture(current, settings, {
    async invoke(request, purpose) {
      requests.push(request);
      if (purpose === 'memory') return output({ memories: [] });
      assert.notEqual(purpose, 'selection');
      return output({ kind: 'answer', content: '完成' });
    },
  });
  assert.equal(facts.execution.status, 'succeeded', JSON.stringify(facts.execution.value.error));
  assert.equal(requests.length, 2);
  assert.equal(
    facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).some((record) => record.name === 'selection'),
    false,
  );
  for (const decision of facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).filter((record) => record.name === 'conversationDecision')) {
    assert.deepEqual(
      decision.value.input.request.history.map((item) => item.index),
      [0, 1, 2],
    );
    assert.equal(
      facts.calls.filter((item) => item.structureKind === 'node').some((record) => record.parentId === decision.id),
      false,
      'routing consumes fixed active material without another model request',
    );
  }
  const generation = facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).find((record) => record.name === 'answer');
  assert.deepEqual(
    generation.value.input.context.selectedMessages.map((item) => item.index),
    [0, 1, 2],
  );
  const prepared = facts.calls.filter((item) => item.structureKind === 'node').find((record) => record.parentId === generation.id && record.name === 'prepareModelRequest');
  assert.deepEqual(readOutput(prepared.value), requests[0]);
  assert.deepEqual(
    JSON.parse(requests[0].messages[1].content).history.map((item) => item.index),
    [0, 1, 2],
  );
  assert.ok(JSON.parse(requests[0].messages[1].content).history.every((item) => !('selectionCount' in item)));
  const rejected = await observeFixture(
    createInput({ content: message.content, history }),
    { ...settings, contextBudget: 256 },
    {
      async invoke() {
        assert.fail('Oversized active material must not invoke the model');
      },
    },
  );
  assert.equal(rejected.execution.status, 'failed');
  assert.equal(rejected.execution.value.error.code, 'CAPACITY_EXCEEDED');
  assert.ok(rejected.execution.value.error.detail.required > 1);
  assert.equal(
    rejected.calls.filter((item) => item.structureKind === 'group' && item.id !== rejected.execution.id).some((record) => record.name === 'requestModel'),
    false,
  );
});
