import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInput, contextFor, transcriptFor, observeFixture } from '../fixtures/observer.mjs';
import { ExecutionRecord, snapshotValue, observeTranscript } from '@capix-observer/runtime';

import { selectionOutputContract } from '@capix-observer/service';

import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const reply = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

test('input is a plain immutable message; the execution range fixes visibility as Transcript grows', () => {
  const original = { content: '她负责什么', history: [{ role: 'user', content: '林岚负责海盐项目' }] };
  const input = createInput(original),
    context = contextFor(input),
    transcript = transcriptFor(input);
  original.content = 'changed';
  original.history[0].content = 'changed';
  transcript.append({ role: 'user', content: 'later message' });
  assert.deepEqual(input, { role: 'user', content: '她负责什么' });
  assert.equal(Object.hasOwn(input, 'transcript'), false);
  assert.equal(context.transcriptRange.end, 2);
  assert.equal(context.transcriptRange.read(1), input);
  assert.equal(context.transcriptRange.read(0).content, '林岚负责海盐项目');
  assert.throws(() => {
    input.content = 'mutated';
  }, TypeError);
  for (const index of [2, -1, 0.5]) assert.throws(() => context.transcriptRange.read(index), RangeError);
  for (const index of [1, 2])
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes: [index] }, { message: input, memories: [] }, context),
      (error) => error.code === 'INDEX_OUT_OF_RANGE',
    );
});

test('only the execution record holds the range; calls consume selected content and ignore later appends', async () => {
  const input = createInput({ content: '她呢', history: [{ role: 'user', content: '林岚负责海盐项目' }] });
  const transcript = transcriptFor(input),
    requests = [],
    snapshots = [];
  const facts = await observeFixture(
    input,
    settings,
    {
      async invoke(request, purpose) {
        requests.push(request);
        if (purpose === 'memory') return reply({ memories: [] });
        if (requests.length === 1) {
          transcript.append({ role: 'user', content: 'later unrelated message' });
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
  assert.equal(facts.attempts.length, 11);
  assert.equal(facts.events.length, 30);
  assert.deepEqual(facts.execution.value.input, input);
  assert.notEqual(facts.execution.value.input, input);
  assert.equal(facts.execution.value.transcriptRange.end, 2);
  assert.equal(facts.execution.value.transcriptRange.transcript, transcript);
  assert.ok(snapshots.every((snapshot) => snapshot.execution.value.transcriptRange === facts.execution.value.transcriptRange));
  for (const record of [...facts.operations, ...facts.attempts]) {
    assert.equal(Object.hasOwn(record.value, 'transcriptRange'), false);
    assert.equal(Object.hasOwn(record.value, 'settings'), false);
  }
  const assembled = readOutput(facts.attempts.find((record) => record.name === 'assembleContext').value);
  assert.deepEqual(assembled.message, input);
  assert.deepEqual(assembled.selectedMessages, [{ index: 0, message: transcript.get(0) }]);
  assert.deepEqual(JSON.parse(requests[1].messages[1].content), { message: input, memories: [], history: [{ index: 0, role: 'user', content: '林岚负责海盐项目' }] });
  const browser = JSON.parse(JSON.stringify(facts, observeTranscript));
  validateSnapshot(browser);
  assert.deepEqual(browser.execution.value.input, input);
  assert.equal(browser.execution.value.transcriptRange.messages.length, 2);
  assert.equal(projectExecution(browser).result.content, '她负责海盐项目');
});

test('record snapshots copy input/configuration values and retain the fixed range reference', () => {
  const input = createInput({ content: 'current message', history: [{ role: 'assistant', content: 'prior' }] });
  const context = contextFor(input, settings);
  const mutable = { input, settings: { ...settings }, transcriptRange: context.transcriptRange };
  const recorded = snapshotValue(mutable);
  assert.notEqual(recorded.input, input);
  assert.notEqual(recorded.settings, mutable.settings);
  assert.equal(recorded.transcriptRange, context.transcriptRange);
  mutable.settings.model = 'changed';
  transcriptFor(input).append({ role: 'user', content: 'later' });
  assert.equal(recorded.settings.model, 'test');
  assert.equal(recorded.transcriptRange.end, 2);
  const record = new ExecutionRecord('context', { ...mutable, startedAt: 'now' });
  assert.equal(record.value.transcriptRange, context.transcriptRange);
  const circular = {};
  circular.self = circular;
  assert.throws(() => snapshotValue(circular), /cyclic/);
  assert.throws(() => snapshotValue(new Map()), /plain/);
});
