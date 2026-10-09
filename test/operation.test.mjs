import { resourceBindingFor, bindChild } from './fixtures/observer.mjs';
import { callFor } from './fixtures/lifecycle.mjs';
import { lifecycleFor, invoke } from './fixtures/lifecycle.mjs';
import { createInput, sourceFor, contextFor, transcriptFor } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestOperation } from './fixtures/operation.mjs';
import { Runtime, TranscriptResource, bindResources } from '@capix-observer/runtime';
import { createRuntime } from './fixtures/runtime.mjs';

import { SelectHistory, AssembleContext, answerOutputContract, selectionOutputContract } from '@capix-observer/service';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 };
const runtime = createRuntime();
const call = (operation, input, operationInput = input, resourceBinding) => invoke(lifecycleFor(runtime).execution({ input, settings, transcript: transcriptFor(input), resourceBinding }), (context) => operation.call(callFor(context), operationInput));
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
  const basis = { start: sourceFor(execution).transcriptRange.start, end: sourceFor(execution).transcriptRange.end - 1 };
  const accepted = selectionOutputContract.accept(value, basis);
  assert.deepEqual(accepted, { historyIndexes: [1, 0] });
  assert.notEqual(accepted.historyIndexes, value.historyIndexes);
  assert.deepEqual(value.historyIndexes, [1, 0]);
  for (const historyIndexes of [[0, 0], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes }, basis),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  }
  assert.throws(
    () => selectionOutputContract.accept({ historyIndexes: [2] }, basis),
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
  const basis = { start: sourceFor(execution).transcriptRange.start, end: sourceFor(execution).transcriptRange.end - 1 };
  const accept = (value) => selectionOutputContract.accept(value, basis);
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
    () => accept({ historyIndexes: [sourceFor(execution).transcriptRange.end - 1] }),
    (error) => error.code === 'INDEX_OUT_OF_RANGE',
  );
});

test('Named actions pass values by reference, await each boundary, without ancestor access', async () => {
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
      assert.equal(context.operationContext, undefined);
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
  let ready;
  const submitted = new Promise((resolve) => {
    ready = resolve;
  });
  const provider = {
    invoke(request) {
      const { message } = JSON.parse(request.messages[1].content);
      const response = new Promise((resolve) => pending.set(message.content, resolve));
      if (pending.size === 2) ready();
      return response;
    },
  };
  const op = bindChild(runtime, new SelectHistory());
  const resourceBinding = resourceBindingFor(runtime, provider);
  const first = { content: 'one', history: [{ role: 'user', content: 'a' }] };
  const second = { content: 'two', history: [...first.history, { role: 'user', content: 'b' }] };
  const original = structuredClone([first, second]);
  const firstMessage = createInput(first);
  const short = call(op, firstMessage, { message: firstMessage, memories: [] }, resourceBinding);
  const secondMessage = createInput(second);
  const long = call(op, secondMessage, { message: secondMessage, memories: [] }, resourceBinding);
  // Surface premature failures instead of spinning forever if setup stops before the provider.
  const prematurelyCompleted = () => assert.fail('Both model requests must be pending before responses are supplied');
  await Promise.race([submitted, short.then(prematurelyCompleted), long.then(prematurelyCompleted)]);
  pending.get('two')(raw('{"historyIndexes":[1]}'));
  assert.deepEqual(await long, { historyIndexes: [1] });
  pending.get('one')(raw('{"historyIndexes":[1]}'));
  await assert.rejects(short, (error) => error.code === 'INDEX_OUT_OF_RANGE');
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
  const attempt = bindChild(runtime, new AssembleContext());
  const result = await invoke(lifecycleFor(runtime).execution({ input: message, settings, transcript: transcriptFor(message), resourceBinding: bindResources({ history: TranscriptResource.fixedRange.request() }, [TranscriptResource.fixedRange.provide((parent) => parent.transcriptRange)]) }), (execution) =>
    runtime.operationInvocations
      .create(callFor(execution), {
        input,
        requires: { history: TranscriptResource.fixedRange.request() },
        description: new TestOperation(runtime),
        work: { maxRounds: 1, execute: (_context, invocation) => attempt.call(invocation, input) },
      })
      .run(),
  );
  assert.equal(result.message, message);
  assert.equal(Object.hasOwn(result.selectedMessages[0], 'transcript'), false);
  assert.equal(result.selectedMessages[0].message, transcriptFor(message).get(0));
  assert.deepEqual(
    result.selectedMessages.map((ref) => ref.index),
    [0],
  );
  assert.equal(result.selectedMessages[0].message.content, 'kept');
});
