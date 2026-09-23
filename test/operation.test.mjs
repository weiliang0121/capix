import { createInput, contextFor, transcriptFor } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestOperation } from './fixtures/operation.mjs';
import { Runtime } from '../dist/server/runtime/runtime.js';
import { invoke } from '../dist/server/invocation/invoke.js';
import { createSelectHistory } from '../dist/server/operations/history/select.js';
import { AssembleContext } from '../dist/server/operations/context/assemble.js';
import { answerOutputContract } from '../dist/server/operations/answer/output.js';
import { selectionOutputContract } from '../dist/server/operations/history/output.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 };
const runtime = new Runtime();
const definition = { name: 'test', label: 'test', source: 'test', phaseSource: 'test' };
const call = (operation, input) => invoke(runtime.execution({ input, settings, transcript: transcriptFor(input) }), (context) => operation.call(context, input));
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
  assert.equal(answerOutputContract.accept(answer), answer);
});

test('selection acceptance separates invalid shape from missing references and orders a copy', () => {
  const input = {
    query: 'x',
    history: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  };
  const message = createInput(input);
  const execution = contextFor(message);
  const value = { historyIndexes: [1, 0] };
  assert.deepEqual(selectionOutputContract.accept(value, message, execution), { historyIndexes: [0, 1] });
  assert.deepEqual(value.historyIndexes, [1, 0]);
  for (const historyIndexes of [[0, 0], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes }, message, execution),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  }
  assert.throws(
    () => selectionOutputContract.accept({ historyIndexes: [2] }, message, execution),
    (error) => error.code === 'INDEX_OUT_OF_RANGE',
  );
});

test('BCA passes values by reference, awaits each boundary, and keeps original input explicit', async () => {
  const input = { query: 'x' },
    prepared = { request: 'y' },
    result = { raw: 'z' };
  const order = [];
  const op = {
    async before(value) {
      assert.equal(value, input);
      order.push('before');
      return prepared;
    },
    async commit(value) {
      assert.equal(value, prepared);
      order.push('commit');
      return result;
    },
    after(value, original) {
      assert.equal(value, result);
      assert.equal(original, input);
      order.push('after');
      return 'accepted';
    },
  };
  assert.equal(await call(new TestOperation(runtime, definition, op), input), 'accepted');
  assert.deepEqual(order, ['before', 'commit', 'after']);
});

test('failure at any BCA phase stops later phases and preserves the thrown error', async () => {
  for (const boundary of ['before', 'commit', 'after']) {
    const order = [],
      failure = new Error(boundary);
    const phase = (name) => (value) => {
      order.push(name);
      if (name === boundary) throw failure;
      return value;
    };
    await assert.rejects(call(new TestOperation(runtime, definition, { before: phase('before'), commit: phase('commit'), after: phase('after') }), {}), (error) => error === failure);
    assert.deepEqual(order, ['before', 'commit', 'after'].slice(0, ['before', 'commit', 'after'].indexOf(boundary) + 1));
  }
});

test('one selection operation can overlap calls without mixing their history bounds', async () => {
  const pending = new Map();
  const provider = {
    invoke(request) {
      const { query } = JSON.parse(request.messages[1].content);
      return new Promise((resolve) => pending.set(query, resolve));
    },
  };
  const op = createSelectHistory(runtime, { provider });
  const first = { query: 'one', history: [{ role: 'user', content: 'a' }] };
  const second = { query: 'two', history: [...first.history, { role: 'user', content: 'b' }] };
  const original = structuredClone([first, second]);
  const short = call(op, createInput(first));
  const shortFailure = assert.rejects(short, (error) => error.code === 'INDEX_OUT_OF_RANGE');
  const long = call(op, createInput(second));
  while (pending.size < 2) await new Promise((resolve) => setImmediate(resolve));
  pending.get('two')(raw('{"historyIndexes":[1]}'));
  assert.deepEqual(await long, { historyIndexes: [1] });
  pending.get('one')(raw('{"historyIndexes":[1]}'));
  await shortFailure;
  assert.deepEqual([first, second], original);
  assert.equal(Object.hasOwn(op, 'context'), false);
});

test('assembly operation consumes explicit sources and needs no recorder', async () => {
  const query = createInput({
    query: 'x',
    history: [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'excluded' },
    ],
  });
  const input = { historyIndexes: [0] };
  const operation = new AssembleContext(runtime);
  assert.equal(operation.before(input), input);
  const result = await invoke(runtime.execution({ input: query, settings, transcript: transcriptFor(query) }), (context) => operation.call(context, input));
  assert.equal(result.query, query);
  assert.equal(Object.hasOwn(result.messages[0], 'transcript'), false);
  assert.equal(result.messages[0].message, transcriptFor(query).get(0));
  assert.deepEqual(
    result.messages.map((ref) => ref.index),
    [0],
  );
  assert.equal(result.messages[0].message.content, 'kept');
});
