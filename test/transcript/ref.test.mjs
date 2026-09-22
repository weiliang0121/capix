import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptQuery } from '../../dist/server/query/input.js';
import { ExecutionRecord } from '../../dist/server/records/execution/record.js';
import { snapshotValue } from '../../dist/server/records/value/snapshot.js';
import { observeTranscript } from '../../dist/server/transcript/observe.js';
import { selectionInput } from '../../dist/server/operations/history/input.js';
import { selectionOutputContract } from '../../dist/server/operations/history/output.js';
import { runQuery } from '../../dist/server/query/run.js';
import { projectExecution, validateSnapshot } from '../../dist/shared/execution/project.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const reply = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('query and history range keep their position and content as Transcript grows', () => {
  const original = { query: '她负责什么', history: [{ role: 'user', content: '林岚负责海盐项目' }] };
  const query = acceptQuery(original),
    input = selectionInput(query);
  original.query = 'changed';
  original.history[0].content = 'changed';
  query.transcript.append({ role: 'user', content: 'later query' });
  assert.equal(query.read().content, '她负责什么');
  assert.equal(input.historyRange.end, 1);
  assert.equal(input.historyRange.ref(0).read().content, '林岚负责海盐项目');
  assert.equal(query.read(), query.transcript.get(query.index));
  assert.throws(() => {
    query.index = 2;
  }, TypeError);
  assert.throws(() => {
    query.read().content = 'mutated';
  }, TypeError);
  assert.throws(() => input.historyRange.ref(1), RangeError);
  assert.throws(() => input.historyRange.ref(-1), RangeError);
  assert.throws(() => input.historyRange.ref(0.5), RangeError);
  assert.throws(
    () => selectionOutputContract.accept({ historyIndexes: [1] }, input),
    (error) => error.code === 'INDEX_OUT_OF_RANGE',
  );
});

test('query execution records keep immutable fact references while browser content is resolved at observation time', async () => {
  const query = acceptQuery({ query: '她呢', history: [{ role: 'user', content: '林岚负责海盐项目' }] });
  const requests = [],
    snapshots = [];
  const facts = await runQuery(
    query,
    settings,
    {
      async invoke(request) {
        requests.push(request);
        if (requests.length === 1) {
          query.transcript.append({ role: 'user', content: 'later unrelated query' });
          return reply({ historyIndexes: [0] });
        }
        return reply({ kind: 'answer', content: '她负责海盐项目' });
      },
    },
    (snapshot) => {
      validateSnapshot(snapshot);
      snapshots.push(snapshot);
    },
  );
  assert.equal(facts.execution.status, 'succeeded');
  assert.equal(facts.operations.length, 3);
  assert.equal(facts.attempts.length, 9);
  assert.equal(facts.events.length, 26);
  assert.equal(facts.execution.value.input, query);
  assert.equal('transcript' in facts.execution.value, false);
  assert.ok(snapshots.every((snapshot) => snapshot.execution.value.input === query));
  const assembled = facts.operations.find((record) => record.operation === 'assemble').value.output;
  assert.equal(assembled.query, query);
  assert.equal(assembled.messages[0].transcript, query.transcript);
  assert.equal(assembled.messages[0].read(), query.transcript.get(0));
  const answerRequest = JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(answerRequest, { query: '她呢', history: [{ index: 0, role: 'user', content: '林岚负责海盐项目' }] });
  const browser = JSON.parse(JSON.stringify(facts, observeTranscript));
  validateSnapshot(browser);
  assert.deepEqual(browser.execution.value.input, { index: 1, message: { role: 'user', content: '她呢' } });
  const selected = browser.operations.find((record) => record.operation === 'assemble').value.output;
  assert.deepEqual(selected.messages, [{ index: 0, message: { role: 'user', content: '林岚负责海盐项目' } }]);
  assert.equal('transcript' in browser.execution.value, false);
  assert.equal(projectExecution(browser).result.content, '她负责海盐项目');
  assert.equal(facts.execution.value.input, query);
});

test('record snapshots copy ordinary values but retain immutable message and range references', () => {
  const query = acceptQuery({ query: 'query', history: [{ role: 'assistant', content: 'prior' }] });
  const input = selectionInput(query);
  const mutable = { input, items: [1] };
  const recorded = snapshotValue(mutable);
  assert.equal(recorded.input.query, query);
  assert.equal(recorded.input.historyRange, input.historyRange);
  assert.notEqual(recorded.items, mutable.items);
  mutable.items.push(2);
  assert.deepEqual(recorded.items, [1]);
  query.transcript.append({ role: 'user', content: 'later' });
  assert.equal(recorded.input.historyRange.end, 1);
  assert.equal(recorded.input.query.read().content, 'query');
  const execution = new ExecutionRecord('context', { input: query, settings, startedAt: 'now' });
  assert.equal(execution.value.input, query);
  assert.equal('transcript' in execution.value, false);
  const circular = {};
  circular.self = circular;
  assert.throws(() => snapshotValue(circular), /cyclic/);
  assert.throws(() => snapshotValue(new Map()), /plain/);
});
