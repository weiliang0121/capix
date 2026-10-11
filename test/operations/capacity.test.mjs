import { resourceBindingFor, bindChild } from '../fixtures/observer.mjs';
import { callFor } from '../fixtures/lifecycle.mjs';
import { lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';
import { readOutput } from '@capix/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transcript, BoundRuntime } from '@capix/server-runtime';
import { createBoundRuntime } from '../fixtures/runtime.mjs';

import { GenerateAnswerDefinition, estimateCapacity } from '@capix/observer-service';

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
  const operation = bindChild(runtime, new GenerateAnswerDefinition());
  const resourceBinding = resourceBindingFor(runtime, provider);
  const history = [...selectedMessages].sort((a, b) => a.index - b.index).map((item) => item.message);
  const transcript = new Transcript([...history, input.message]);
  const selection = { historyIndexes: input.selectedMessages.map((item) => item.index) };
  await invoke(lifecycleFor(runtime).execution({ input: transcript.current('user'), transcript, resourceBinding, settings: { ...settings, contextBudget } }), (context) => operation.call(callFor(context), { selection, memories: [] }));
  return requests[0];
}

test('generation fits the priority prefix, stops at the first overflow and restores chronological order', async () => {
  const full = await generate(input);
  assert.deepEqual(
    JSON.parse(full.messages[1].content).history.map((item) => item.index),
    [0, 1, 2],
  );
  const prefix = withHistory(full, [0, 2]);
  const exactBudget = required(prefix);
  const exact = await generate(input, exactBudget);
  assert.deepEqual(exact, prefix);
  assert.equal(estimateCapacity(exact, { ...settings, contextBudget: exactBudget }).required, exactBudget);

  const truncated = await generate(input, exactBudget - 1);
  assert.deepEqual(JSON.parse(truncated.messages[1].content).history, [{ index: 2, ...selectedMessages[0].message }]);
  // The smaller third item would fit, but must not replace the second item.
  assert.ok(required(withHistory(full, [1, 2])) < exactBudget - 1);
  assert.deepEqual(
    input.selectedMessages.map((item) => item.index),
    [2, 0, 1],
  );
  assert.deepEqual(JSON.parse(truncated.messages[1].content).message, message);
});

test('an oversized first selection fails before invoking the model instead of falling back to no history', async () => {
  const full = await generate(input);
  const budget = required(withHistory(full, [2])) - 1;
  assert.ok(required(withHistory(full, [])) < budget);
  const requests = [];
  await assert.rejects(generate(input, budget, requests), (error) => error.code === 'CAPACITY_EXCEEDED' && error.detail.required === budget + 1 && error.detail.fits === false);
  assert.equal(requests.length, 0);
});

test('empty selection can fit exactly; fixed request content and output reserve cannot be truncated', async () => {
  const empty = { message, selectedMessages: [] };
  const full = await generate(empty);
  const budget = required(full);
  assert.deepEqual(await generate(empty, budget), full);
  const requests = [];
  await assert.rejects(generate(empty, budget - 1, requests), (error) => error.code === 'CAPACITY_EXCEEDED' && error.detail.reservedOutputTokens === settings.maxOutputTokens);
  assert.equal(requests.length, 0);
});

test('the observed execution preserves ranking, records actual requests and accounts for full selection request capacity', async () => {
  const history = [...selectedMessages].sort((a, b) => a.index - b.index).map((item) => item.message);
  const current = createInput({ content: message.content, history });
  const requests = [];
  const facts = await observeFixture(current, settings, {
    async invoke(request, purpose) {
      requests.push(request);
      if (purpose === 'memory') return output({ memories: [] });
      if (purpose === 'selection') {
        assert.match(request.messages[0].content, /从高到低/);
        return output({ historyIndexes: [2, 0, 1] });
      }
      return output({ kind: 'answer', content: '完成' });
    },
  });
  assert.equal(facts.execution.status, 'succeeded', JSON.stringify(facts.execution.value.error));
  assert.equal(requests.length, 3);
  assert.deepEqual(
    facts.operations.map((record) => record.operation),
    ['selection', 'conversationDecision', 'answer', 'conversationDecision', 'memory'],
  );
  assert.deepEqual(readOutput(facts.operations.find((record) => record.operation === 'selection').value).historyIndexes, [2, 0, 1]);
  for (const decision of facts.operations.filter((record) => record.operation === 'conversationDecision')) {
    assert.deepEqual(decision.value.input.request.selection.historyIndexes, [2, 0, 1]);
    assert.equal(
      facts.attempts.some((record) => record.operationId === decision.id),
      false,
      'routing consumes accepted ranking without another model request',
    );
  }
  const generation = facts.operations.find((record) => record.operation === 'answer');
  assert.deepEqual(generation.value.input.selection.historyIndexes, [2, 0, 1]);
  const prepared = facts.attempts.find((record) => record.operationId === generation.id && record.name === 'prepareModelRequest');
  assert.deepEqual(readOutput(prepared.value), requests[1]);
  assert.deepEqual(
    JSON.parse(requests[1].messages[1].content).history.map((item) => item.index),
    [0, 1, 2],
  );
  assert.ok(JSON.parse(requests[0].messages[1].content).history.every((item) => !('selectionCount' in item)));
  const rejected = await observeFixture(
    createInput({ content: message.content, history }),
    { ...settings, contextBudget: 256 },
    {
      async invoke() {
        assert.fail('Oversized selection request must not invoke the model');
      },
    },
  );
  assert.equal(rejected.execution.status, 'failed');
  assert.equal(rejected.execution.value.error.code, 'CAPACITY_EXCEEDED');
  assert.ok(rejected.execution.value.error.detail.required > 1);
  assert.equal(rejected.operations.length, 1);
});
