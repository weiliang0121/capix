import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import { createInput, contextFor, transcriptFor } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestOperation } from './fixtures/operation.mjs';
import { Runtime } from '@capix-observer/runtime';

import { SelectHistory, AssembleContext, answerOutputContract, selectionOutputContract } from '@capix-observer/service';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 };
const runtime = new Runtime();
const call = (operation, input, operationInput = input) => invoke(lifecycleFor(runtime).execution({ input, settings, transcript: transcriptFor(input) }), (context) => operation.call(context, operationInput));
const raw = (content) => ({
  id: 'test',
  model: 'test',
  content,
  finishReason: 'stop',
  usage: null,
});

test('answer acceptance rejects coerced kinds and preserves accepted text', () => {
  let coerced = false;
  const kind = {
    toString() {
      coerced = true;
      return 'answer';
    },
  };
  assert.throws(
    () => answerOutputContract.accept({ kind, content: 'x' }),
    (error) => error.code === 'OUTPUT_SHAPE',
  );
  assert.equal(coerced, false);
  assert.throws(
    () => answerOutputContract.accept({ kind: ['answer'], content: 'x' }),
    (error) => error.code === 'OUTPUT_SHAPE',
  );
  assert.throws(
    () => answerOutputContract.accept({ kind: 'answer', content: '  ' }),
    (error) => error.code === 'OUTPUT_SHAPE',
  );
  const answer = { kind: 'answer', content: '  original text  ' };
  const accepted = answerOutputContract.accept(answer);
  assert.deepEqual(accepted, answer);
  assert.notEqual(accepted, answer);
  accepted.content = 'changed';
  assert.equal(answer.content, '  original text  ');
});

test('answer contract keeps strict model schema and reports invalid output paths', () => {
  const schema = answerOutputContract.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['kind', 'content']);
  assert.deepEqual(schema.properties.kind.enum, ['answer', 'unknown', 'needs-info']);
  assert.equal(schema.properties.content.type, 'string');
  assert.equal(schema.properties.content.minLength, 1);
  assert.equal(new RegExp(schema.properties.content.pattern).test(' \t\n '), false);
  assert.equal(new RegExp(schema.properties.content.pattern).test('  正文  '), true);
  for (const kind of schema.properties.kind.enum) assert.deepEqual(answerOutputContract.accept({ kind, content: 'ok' }), { kind, content: 'ok' });
  for (const value of [{ kind: 'answer' }, { kind: 'answer', content: null }, { kind: 'answer', content: '' }, { kind: 'answer', content: '\n\t ' }]) {
    assert.throws(
      () => answerOutputContract.accept(value),
      (error) => error.code === 'OUTPUT_SHAPE' && error.detail.issues.some((issue) => issue.path.join('.') === 'content'),
    );
  }
  const extra = { kind: 'answer', content: 'ok', additionalProperties: false };
  assert.throws(
    () => answerOutputContract.accept(extra),
    (error) => error.code === 'OUTPUT_SHAPE' && error.detail.issues.some((issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('additionalProperties')),
  );
  assert.equal(extra.additionalProperties, false);
});

test('selection acceptance separates invalid shape from missing references and preserves priority in a copy', () => {
  const input = {
    content: 'x',
    history: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  };
  const message = createInput(input);
  const execution = contextFor(message);
  const value = { historyIndexes: [1, 0] };
  const selectionInput = { message, memories: [] };
  const accepted = selectionOutputContract.accept(value, selectionInput, execution);
  assert.deepEqual(accepted, { historyIndexes: [1, 0] });
  assert.notEqual(accepted.historyIndexes, value.historyIndexes);
  assert.deepEqual(value.historyIndexes, [1, 0]);
  for (const historyIndexes of [[0, 0], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes }, selectionInput, execution),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  }
  assert.throws(
    () => selectionOutputContract.accept({ historyIndexes: [2] }, selectionInput, execution),
    (error) => error.code === 'INDEX_OUT_OF_RANGE',
  );
});

test('selection schema preserves empty results, ranked indexes and detailed strict-shape failures', () => {
  const message = createInput({
    content: '继续',
    history: [
      { role: 'user', content: '前文' },
      { role: 'assistant', content: '回答' },
    ],
  });
  const execution = contextFor(message);
  const input = { message, memories: [] };
  const accept = (value) => selectionOutputContract.accept(value, input, execution);
  assert.deepEqual(accept({ historyIndexes: [] }), { historyIndexes: [] });
  for (const value of [{}, { historyIndexes: null }, { historyIndexes: ['0'] }, { historyIndexes: [NaN] }, { historyIndexes: [Infinity] }, { historyIndexes: [0, 0] }, { historyIndexes: [], extra: true }]) {
    assert.throws(
      () => accept(value),
      (error) => error.code === 'OUTPUT_SHAPE' && error.detail.issues.length > 0,
    );
  }
  const schema = selectionOutputContract.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['historyIndexes']);
  assert.equal(schema.properties.historyIndexes.uniqueItems, true);
  assert.equal(schema.properties.historyIndexes.items.minimum, 0);
  assert.equal(schema.properties.historyIndexes.items.maximum, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => accept({ historyIndexes: [execution.transcriptRange.end - 1] }),
    (error) => error.code === 'INDEX_OUT_OF_RANGE',
  );
});

test('Named actions pass values by reference, await each boundary, and resolve original input from the owning operation', async () => {
  const input = { content: 'x' },
    loadedOutput = { request: 'y' },
    result = { raw: 'z' };
  const order = [];
  const op = {
    async load(value, context) {
      assert.equal(context.input, value);
      assert.equal(value, input);
      order.push('load');
      return loadedOutput;
    },
    async transform(value, context) {
      assert.equal(context.input, value);
      assert.equal(value, loadedOutput);
      order.push('transform');
      return result;
    },
    accept(value, context) {
      assert.equal(context.input, value);
      assert.equal(value, result);
      assert.equal(runtime.getOperationContext(context).input, input);
      order.push('accept');
      return 'accepted';
    },
  };
  assert.equal(await call(new TestOperation(runtime, op), input), 'accepted');
  assert.deepEqual(order, ['load', 'transform', 'accept']);
});

test('failure at any action stops later actions and preserves the thrown error', async () => {
  for (const boundary of ['load', 'transform', 'accept']) {
    const order = [],
      failure = new Error(boundary);
    const action = (name) => (value) => {
      order.push(name);
      if (name === boundary) throw failure;
      return value;
    };
    await assert.rejects(call(new TestOperation(runtime, { load: action('load'), transform: action('transform'), accept: action('accept') }), {}), (error) => error === failure);
    assert.deepEqual(order, ['load', 'transform', 'accept'].slice(0, ['load', 'transform', 'accept'].indexOf(boundary) + 1));
  }
});

test('one selection operation can overlap calls without mixing their history bounds', async () => {
  const pending = new Map();
  const provider = {
    invoke(request) {
      const { message } = JSON.parse(request.messages[1].content);
      return new Promise((resolve) => pending.set(message.content, resolve));
    },
  };
  const op = new SelectHistory(runtime, provider);
  const first = { content: 'one', history: [{ role: 'user', content: 'a' }] };
  const second = { content: 'two', history: [...first.history, { role: 'user', content: 'b' }] };
  const original = structuredClone([first, second]);
  const firstMessage = createInput(first);
  const short = call(op, firstMessage, { message: firstMessage, memories: [] });
  const shortFailure = assert.rejects(short, (error) => error.code === 'INDEX_OUT_OF_RANGE');
  const secondMessage = createInput(second);
  const long = call(op, secondMessage, { message: secondMessage, memories: [] });
  while (pending.size < 2) await new Promise((resolve) => setImmediate(resolve));
  pending.get('two')(raw('{"historyIndexes":[1]}'));
  assert.deepEqual(await long, { historyIndexes: [1] });
  pending.get('one')(raw('{"historyIndexes":[1]}'));
  await shortFailure;
  assert.deepEqual([first, second], original);
  assert.equal(Object.hasOwn(op, 'context'), false);
});

test('assembly attempt consumes explicit sources and needs no recorder', async () => {
  const message = createInput({
    content: 'x',
    history: [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'excluded' },
    ],
  });
  const input = { historyIndexes: [0] };
  const attempt = new AssembleContext(runtime);
  const result = await invoke(lifecycleFor(runtime).execution({ input: message, settings, transcript: transcriptFor(message) }), (execution) => invoke(lifecycleFor(runtime).operation(execution, new TestOperation(runtime), input), (context) => attempt.call(context, input)));
  assert.equal(result.message, message);
  assert.equal(Object.hasOwn(result.selectedMessages[0], 'transcript'), false);
  assert.equal(result.selectedMessages[0].message, transcriptFor(message).get(0));
  assert.deepEqual(
    result.selectedMessages.map((ref) => ref.index),
    [0],
  );
  assert.equal(result.selectedMessages[0].message.content, 'kept');
});
