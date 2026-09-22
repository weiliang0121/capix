import { acceptQuery } from '../dist/server/query/input.js';
import { selectionInput } from '../dist/server/operations/history/input.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOperation } from '../dist/server/operations/operation.js';
import { createSelectHistory } from '../dist/server/operations/history/select.js';
import { assembleContextOperation } from '../dist/server/operations/context/assemble.js';
import { answerOutputContract } from '../dist/server/operations/answer/output.js';
import { selectionOutputContract } from '../dist/server/operations/history/output.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 };
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
  const value = { historyIndexes: [1, 0] };
  assert.deepEqual(selectionOutputContract.accept(value, selectionInput(acceptQuery(input))), { historyIndexes: [0, 1] });
  assert.deepEqual(value.historyIndexes, [1, 0]);
  for (const historyIndexes of [[0, 0], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes }, selectionInput(acceptQuery(input))),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  }
  assert.throws(
    () => selectionOutputContract.accept({ historyIndexes: [2] }, selectionInput(acceptQuery(input))),
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
  assert.equal(await runOperation(op, input), 'accepted');
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
    await assert.rejects(runOperation({ before: phase('before'), commit: phase('commit'), after: phase('after') }, {}), (error) => error === failure);
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
  const op = createSelectHistory({ settings, provider, signal: new AbortController().signal });
  const first = { query: 'one', history: [{ role: 'user', content: 'a' }] };
  const second = { query: 'two', history: [...first.history, { role: 'user', content: 'b' }] };
  const original = structuredClone([first, second]);
  const short = runOperation(op, selectionInput(acceptQuery(first)));
  const shortFailure = assert.rejects(short, (error) => error.code === 'INDEX_OUT_OF_RANGE');
  const long = runOperation(op, selectionInput(acceptQuery(second)));
  await Promise.resolve();
  pending.get('two')(raw('{"historyIndexes":[1]}'));
  assert.deepEqual(await long, { historyIndexes: [1] });
  pending.get('one')(raw('{"historyIndexes":[1]}'));
  await shortFailure;
  assert.deepEqual([first, second], original);
  assert.deepEqual(Object.keys(op).sort(), ['after', 'before', 'commit']);
});

test('assembly operation consumes explicit sources and needs no recorder', async () => {
  const query = acceptQuery({
    query: 'x',
    history: [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'excluded' },
    ],
  });
  const input = { original: selectionInput(query), selection: { historyIndexes: [0] } };
  assert.equal(assembleContextOperation.before(input), input);
  const result = await runOperation(assembleContextOperation, input);
  assert.equal(result.query, query);
  assert.equal(result.messages[0].transcript, query.transcript);
  assert.equal(result.messages[0].read(), query.transcript.get(0));
  assert.deepEqual(
    result.messages.map((ref) => ref.index),
    [0],
  );
  assert.equal(Object.hasOwn(result.messages[0], 'content'), false);
});
