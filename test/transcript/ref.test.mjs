import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInput, sourceFor, contextFor, transcriptFor, observeFixture } from '../fixtures/observer.mjs';
import { ExecutionRecord, snapshotValue } from '@capix/records';

import { selectionOutputContract } from '@capix/observer-service';

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
  assert.equal(sourceFor(context).transcriptRange.end, 2);
  assert.equal(sourceFor(context).transcriptRange.read(1), input);
  assert.equal(sourceFor(context).transcriptRange.read(0).content, '林岚负责海盐项目');
  assert.throws(() => {
    input.content = 'mutated';
  }, TypeError);
  for (const index of [2, -1, 0.5]) assert.throws(() => sourceFor(context).transcriptRange.read(index), RangeError);
  for (const index of [1, 2])
    assert.throws(
      () => selectionOutputContract.accept({ historyIndexes: [index] }, { start: sourceFor(context).transcriptRange.start, end: sourceFor(context).transcriptRange.end - 1 }),
      (error) => error.code === 'INDEX_OUT_OF_RANGE',
    );
});

test('resource facts hold plain range locators; calls consume selected content and ignore later appends', async () => {
  const input = createInput({ content: '她呢', history: [{ role: 'user', content: '林岚负责海盐项目' }] });
  const transcript = transcriptFor(input);
  const requests = [];
  const snapshots = [];
  const facts = await observeFixture(
    input,
    settings,
    {
      async invoke(request, purpose) {
        requests.push(request);
        if (purpose === 'memory') return reply({ memories: [] });
        if (requests.length === 1) {
          transcriptFor(input).append({ role: 'user', content: 'later unrelated message' });
        }
        return reply({ kind: 'answer', content: '她负责海盐项目' });
      },
    },
    (snapshot) => {
      validateExecutionRecordSnapshot(snapshot);
      snapshots.push(snapshot);
    },
  );
  assert.equal(facts.execution.status, 'succeeded');
  assert.deepEqual(
    facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).map((record) => record.name),
    ['prepareContext', 'conversationDecision', 'answer', 'answerCandidate', 'requestModel', 'conversationDecision', 'memory', 'requestModel'],
  );
  assert.equal(facts.calls.filter((item) => item.structureKind === 'node').length, 8);
  assert.equal(facts.boundaries.filter((event) => event.callId !== facts.rootCall.id).length, 2 * (1 + facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).length + facts.calls.filter((item) => item.structureKind === 'node').length));
  for (const decision of facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).filter((record) => record.name === 'conversationDecision')) {
    assert.deepEqual(
      decision.value.input.request.history.map((item) => item.index),
      [0],
    );
    assert.equal(JSON.stringify(decision.value.input).includes('later unrelated message'), false);
  }
  assert.deepEqual(facts.execution.value.input, input);
  assert.notEqual(facts.execution.value.input, input);
  const rangeFact = facts.resources.find((fact) => fact.parentId === facts.execution.id && fact.access === 'transcript.fixedRange' && fact.phase === 'available');
  assert.equal(rangeFact.value.end, 2);
  assert.equal(rangeFact.value.transcriptId, transcriptFor(input).id);
  assert.equal(rangeFact.value.transcript, undefined);
  assert.ok(snapshots.filter((snapshot) => snapshot.resources.some((fact) => fact.id === rangeFact.id)).every((snapshot) => snapshot.resources.find((fact) => fact.id === rangeFact.id).value.end === 2));
  for (const record of [...facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id), ...facts.calls.filter((item) => item.structureKind === 'node')]) {
    assert.equal(Object.hasOwn(record.value, 'transcriptRange'), false);
    assert.equal(Object.hasOwn(record.value, 'settings'), false);
  }
  const assembled = readOutput(facts.calls.filter((item) => item.structureKind === 'node').find((record) => record.name === 'assembleContext').value);
  assert.deepEqual(assembled.message, input);
  assert.deepEqual(assembled.selectedMessages, [{ index: 0, message: transcript.get(0) }]);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), { message: input, memories: [], history: [{ index: 0, role: 'user', content: '林岚负责海盐项目' }] });
  const browser = JSON.parse(JSON.stringify(facts));
  validateExecutionRecordSnapshot(browser);
  assert.deepEqual(browser.execution.value.input, input);
  assert.equal(browser.resources.find((fact) => fact.id === rangeFact.id).value.end, 2);
  assert.equal(browser.resources.find((fact) => fact.id === rangeFact.id).value.messages, undefined);
  assert.equal(projectExecution(browser).result.content, '她负责海盐项目');
});

test('record snapshots copy plain locators and reject live range references', () => {
  const input = createInput({ content: 'current message', history: [{ role: 'assistant', content: 'prior' }] });
  const context = contextFor(input, settings);
  const transcript = transcriptFor(input);
  const mutable = { input, settings: { ...settings }, history: { transcriptId: transcript.id, start: 0, end: 2 } };
  const recorded = snapshotValue(mutable);
  assert.notEqual(recorded.input, input);
  assert.notEqual(recorded.settings, mutable.settings);
  assert.notEqual(recorded.history, mutable.history);
  mutable.settings.model = 'changed';
  transcript.append({ role: 'user', content: 'later' });
  assert.equal(recorded.settings.model, 'test');
  assert.equal(recorded.history.end, 2);
  assert.throws(() => snapshotValue(sourceFor(context).transcriptRange), /plain/);
  const record = new ExecutionRecord('context', { input, startedAt: 'now' }, 'runtime-record');
  assert.equal(record.value.transcriptRange, undefined);
  const circular = {};
  circular.self = circular;
  assert.throws(() => snapshotValue(circular), /cyclic/);
  assert.throws(() => snapshotValue(new Map()), /plain/);
});
