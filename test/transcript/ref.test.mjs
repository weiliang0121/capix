import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInput, contextFor, transcriptFor, observeFixture } from '../fixtures/observer.mjs';
import { ExecutionRecord } from '../../dist/server/records/execution/record.js';
import { snapshotValue } from '../../dist/server/records/value/snapshot.js';
import { observeTranscript } from '../../dist/server/transcript/observe.js';
import { selectionOutputContract } from '../../dist/server/operations/history/output.js';
import { projectExecution, validateSnapshot } from '../../dist/shared/execution/project.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const reply = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('input is a plain immutable message; the execution range fixes visibility as Transcript grows', () => {
  const original = { query: '她负责什么', history: [{ role: 'user', content: '林岚负责海盐项目' }] };
  const input = createInput(original),
    context = contextFor(input),
    transcript = transcriptFor(input);
  original.query = 'changed';
  original.history[0].content = 'changed';
  transcript.append({ role: 'user', content: 'later query' });
  assert.deepEqual(input, { role: 'user', content: '她负责什么' });
  assert.equal(Object.hasOwn(input, 'transcript'), false);
  assert.equal(context.transcript.end, 2);
  assert.equal(context.transcript.read(1), input);
  assert.equal(context.transcript.read(0).content, '林岚负责海盐项目');
  assert.throws(() => {
    input.content = 'mutated';
  }, TypeError);
  for (const index of [2, -1, 0.5]) assert.throws(() => context.transcript.read(index), RangeError);
  for (const index of [1, 2])
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes: [index] }, input, context),
      (error) => error.code === 'INDEX_OUT_OF_RANGE',
    );
});

test('only the execution record holds the range; calls consume selected content and ignore later appends', async () => {
  const input = createInput({ query: '她呢', history: [{ role: 'user', content: '林岚负责海盐项目' }] });
  const transcript = transcriptFor(input),
    requests = [],
    snapshots = [];
  const facts = await observeFixture(
    input,
    settings,
    {
      async invoke(request) {
        requests.push(request);
        if (requests.length === 1) {
          transcript.append({ role: 'user', content: 'later unrelated query' });
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
  assert.deepEqual(facts.execution.value.input, input);
  assert.notEqual(facts.execution.value.input, input);
  assert.equal(facts.execution.value.transcript.end, 2);
  assert.equal(facts.execution.value.transcript.transcript, transcript);
  assert.ok(snapshots.every((snapshot) => snapshot.execution.value.transcript === facts.execution.value.transcript));
  for (const record of [...facts.operations, ...facts.attempts]) {
    assert.equal(Object.hasOwn(record.value, 'transcript'), false);
    assert.equal(Object.hasOwn(record.value, 'settings'), false);
  }
  const assembled = facts.operations.find((record) => record.operation === 'assemble').value.output;
  assert.deepEqual(assembled.query, input);
  assert.deepEqual(assembled.messages, [{ index: 0, message: transcript.get(0) }]);
  assert.deepEqual(JSON.parse(requests[1].messages[1].content), { query: '她呢', history: [{ index: 0, role: 'user', content: '林岚负责海盐项目' }] });
  const browser = JSON.parse(JSON.stringify(facts, observeTranscript));
  validateSnapshot(browser);
  assert.deepEqual(browser.execution.value.input, input);
  assert.equal(browser.execution.value.transcript.messages.length, 2);
  assert.equal(projectExecution(browser).result.content, '她负责海盐项目');
});

test('record snapshots copy input/configuration values and retain the fixed range reference', () => {
  const input = createInput({ query: 'query', history: [{ role: 'assistant', content: 'prior' }] });
  const context = contextFor(input, settings);
  const mutable = { input, settings: { ...settings }, transcript: context.transcript };
  const recorded = snapshotValue(mutable);
  assert.notEqual(recorded.input, input);
  assert.notEqual(recorded.settings, mutable.settings);
  assert.equal(recorded.transcript, context.transcript);
  mutable.settings.model = 'changed';
  transcriptFor(input).append({ role: 'user', content: 'later' });
  assert.equal(recorded.settings.model, 'test');
  assert.equal(recorded.transcript.end, 2);
  const record = new ExecutionRecord('context', { ...mutable, startedAt: 'now' });
  assert.equal(record.value.transcript, context.transcript);
  const circular = {};
  circular.self = circular;
  assert.throws(() => snapshotValue(circular), /cyclic/);
  assert.throws(() => snapshotValue(new Map()), /plain/);
});
