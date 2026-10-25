import { createConversationRunner } from '../fixtures/conversation-runner.mjs';
import { ModelInteractions, ModelSource } from '@capix/observer-service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationSubmission, createConversationStructure } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const input = { messages: [{ role: 'user', content: 'private input never belongs in activity' }] };
const response = (purpose) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'private answer' }), finishReason: 'stop', usage: null });
const complete = (submission) =>
  new Promise((resolve) => {
    let disconnect = () => {};
    disconnect = submission.connect((snapshot) => {
      if (snapshot.result) {
        disconnect();
        resolve(snapshot);
      }
    });
    if (submission.snapshot.result) disconnect();
  });
const fact = (contextId, structureKind, kind, eventSequence, extra = {}, parentContextId) => ({ identity: { contextId, kind: structureKind, ...(parentContextId ? { parentContextId } : {}) }, kind, eventSequence, occurredAt: '2026-10-11T00:00:00.000Z', ...extra });

test('submission exposes live REOA calls and parent acceptance without installing recording', async () => {
  const environment = createEnvironment();
  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const runner = createConversationRunner(
    createConversationStructure(),
    environment,
    new ModelInteractions(
      new ModelSource({
        async invoke(_request, purpose) {
          if (purpose === 'answer') {
            entered();
            await gate;
          }
          return response(purpose);
        },
      }),
    ),
  );
  const submission = new ConversationSubmission('activity', 'conversation');
  submission.start((signal) => runner.run(input, { settings, signal, progress: submission.progress, activity: submission.activity }));
  await entering;
  const during = submission.snapshot;
  assert.equal(during.result, undefined);
  assert.equal(during.activities.integrity.status, 'complete');
  assert.deepEqual(new Set(during.activities.calls.map((call) => call.kind)), new Set(['scene', 'group', 'node']));
  assert.ok(during.activities.calls.some((call) => call.kind === 'node' && call.label === '发起模型调用' && call.status === 'running'));
  assert.ok(
    during.activities.calls.some((call) => call.kind === 'node' && call.status === 'succeeded'),
    'completed short activities remain visible',
  );
  release();
  const finished = await complete(submission);
  assert.equal(finished.result.status, 'completed');
  assert.equal(finished.integrity.status, 'complete');
  assert.equal(finished.activities.integrity.status, 'complete');
  assert.ok(finished.activities.calls.every((call) => call.status === 'succeeded'));
  for (const call of finished.activities.calls) {
    assert.ok(call.startedAt);
    assert.ok(call.finishedAt);
    if (call.parentContextId !== undefined) {
      assert.ok(finished.activities.calls.some((parent) => parent.contextId === call.parentContextId));
      assert.equal(call.relation.phase, 'accepted');
      assert.equal(call.relation.returned, 'succeeded');
    }
    assert.ok(Object.isFrozen(call));
    for (const forbidden of ['input', 'output', 'source', 'callee', 'error', 'reasoning']) assert.equal(forbidden in call, false);
  }
  assert.equal(JSON.stringify(finished.activities).includes('private'), false);
  assert.equal(environment.runtime.recording, undefined);
});

test('activity keeps failed child and new retry identities while the parent succeeds with one explicit retry', async () => {
  let answers = 0;

  const runner = createConversationRunner(
    createConversationStructure(),
    createEnvironment(),
    new ModelInteractions(
      new ModelSource({
        async invoke(_request, purpose) {
          if (purpose === 'answer' && ++answers === 1) return { ...response(purpose), content: '{invalid JSON' };
          return response(purpose);
        },
      }),
    ),
  );
  const submission = new ConversationSubmission('retry-activity', 'conversation');
  submission.start((signal) => runner.run(input, { settings, signal, progress: submission.progress, activity: submission.activity }));
  const snapshot = await complete(submission);
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.activities.integrity.status, 'complete');
  const generation = snapshot.activities.calls.find((call) => call.kind === 'group' && call.label === '生成回答');
  assert.equal(generation.status, 'succeeded');
  assert.equal(generation.round, 1);
  const children = snapshot.activities.calls.filter((call) => call.parentContextId === generation.contextId);
  const candidates = children.filter((call) => call.kind === 'group' && call.label === '生成回答候选');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].relation.phase, 'handled');
  const modelCalls = snapshot.activities.calls.filter((call) => candidates.some((candidate) => call.parentContextId === candidate.contextId) && call.kind === 'group' && call.label === '请求模型');
  assert.equal(modelCalls.length, 2);
  assert.notEqual(modelCalls[0].contextId, modelCalls[1].contextId);
  for (const model of modelCalls) assert.equal(snapshot.activities.calls.filter((call) => call.parentContextId === model.contextId && call.kind === 'node' && call.label === '发起模型调用').length, 1);
  assert.ok(children.some((call) => call.status === 'failed' && call.relation.returned === 'failed'));
});

test('activity source failure is independent of committed content and actual submission completion', async () => {
  const environment = createEnvironment();

  const runner = createConversationRunner(
    createConversationStructure(),
    environment,
    new ModelInteractions(
      new ModelSource({
        async invoke(_request, purpose) {
          return response(purpose);
        },
      }),
    ),
  );
  const submission = new ConversationSubmission('activity-incomplete', 'conversation');
  submission.activity.publish(fact('orphan', 'node', 'started', 1, {}, 'missing-parent'));
  assert.equal(submission.snapshot.activities.integrity.status, 'incomplete');
  const retained = submission.snapshot.activities;
  submission.start((signal) => runner.run(input, { settings, signal, progress: submission.progress, activity: submission.activity }));
  const finished = await complete(submission);
  assert.equal(finished.activities, retained);
  assert.equal(finished.integrity.status, 'complete');
  assert.equal(finished.result.status, 'completed');
  assert.equal(finished.answer.index, 1);
  assert.equal(environment.transcript.length, 2);
});

test('activity capacity retains the known prefix and reports permanent independent incompleteness', () => {
  const submission = new ConversationSubmission('activity-capacity', 'conversation');
  submission.activity.publish(fact('r', 'scene', 'started', 1));
  for (let index = 0; index < 512; index++) submission.activity.publish(fact(`e-${index}`, 'group', 'started', 1, {}, 'r'));
  assert.equal(submission.snapshot.activities.calls.length, 512);
  assert.equal(submission.snapshot.activities.integrity.status, 'incomplete');
  assert.equal(submission.snapshot.activities.integrity.error.code, 'ACTIVITY_INCOMPLETE');
  assert.equal(submission.snapshot.integrity.status, 'complete');
  const retained = submission.snapshot.activities;
  submission.activity.publish(fact('r', 'scene', 'finished', 2, { status: 'succeeded' }));
  assert.equal(submission.snapshot.activities, retained);
});

test('failure before started is represented as setup and a successful call can still fail parent delivery', () => {
  const submission = new ConversationSubmission('activity-relations', 'conversation');
  submission.activity.publish(fact('r', 'scene', 'started', 1));
  const relation = { parentContextId: 'r', childContextId: 'e', parentRound: 1 };
  submission.activity.publish(fact('r', 'scene', 'relation', 2, { relation, phase: 'attached' }));
  submission.activity.publish(fact('e', 'group', 'finished', 1, { status: 'failed' }, 'r'));
  submission.activity.publish(fact('r', 'scene', 'relation', 3, { relation, phase: 'returned', status: 'failed' }));
  const setup = submission.snapshot.activities.calls.find((call) => call.contextId === 'e');
  assert.equal(setup.phase, 'setup');
  assert.equal(setup.startedAt, undefined);
  assert.equal(setup.status, 'failed');
  assert.equal(setup.relation.returned, 'failed');
  const another = { parentContextId: 'r', childContextId: 'e2', parentRound: 1 };
  submission.activity.publish(fact('r', 'scene', 'relation', 4, { relation: another, phase: 'attached' }));
  submission.activity.publish(fact('e2', 'group', 'started', 1, {}, 'r'));
  submission.activity.publish(fact('e2', 'group', 'finished', 2, { status: 'succeeded' }, 'r'));
  submission.activity.publish(fact('r', 'scene', 'relation', 5, { relation: another, phase: 'returned', status: 'failed' }));
  const delivery = submission.snapshot.activities.calls.find((call) => call.contextId === 'e2');
  assert.equal(delivery.status, 'succeeded');
  assert.equal(delivery.relation.returned, 'failed');
  assert.equal(submission.snapshot.activities.integrity.status, 'complete');
});
