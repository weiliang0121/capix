import { createConversationRunner } from '../fixtures/conversation-runner.mjs';
import { ModelInteractions, ModelSource } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';
import { resourceFact } from '../fixtures/observer.mjs';
import { readOutput } from '@capix/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptConversationInput, observeExecution } from '@capix/observer-service';

const settings = { model: 'test', contextBudget: 100000, maxOutputTokens: 256, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });

for (const fails of [false, true]) {
  test(`active-material preparation is recorded without appending messages when generation ${fails ? 'fails' : 'succeeds'}`, async () => {
    const requests = [];
    const environment = initializeObserver({
      async invoke(request, purpose) {
        requests.push(request);
        if (purpose === 'memory') return raw({ memories: [] });
        assert.deepEqual(environment.transcript.snapshot(), messagesBefore);
        assert.notEqual(purpose, 'selection');
        assert.deepEqual(
          JSON.parse(request.messages[1].content).history.map(({ index }) => index),
          [0, 1],
        );
        if (fails) throw new Error('generation failed');
        return raw({ kind: 'answer', content: '在南楼201。' });
      },
    });
    const input = {
      messages: [
        { role: 'user', content: '春芽活动在南楼201。' },
        { role: 'assistant', content: '已了解活动地点。' },
        { role: 'user', content: '活动在哪里？' },
      ],
    };
    const messagesBefore = input.messages;
    const facts = await observeExecution(environment.runner, environment.records.installation, input, { settings, transcript: environment.transcript });
    const selection = facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).find((operation) => operation.name === 'prepareContext');
    assert.equal(selection.status, 'succeeded');
    assert.deepEqual(readOutput(selection.value).selection, { historyIndexes: [0, 1] });
    assert.equal(requests.length, fails ? 1 : 2);
    assert.equal(facts.execution.status, fails ? 'failed' : 'succeeded');
    assert.equal(resourceFact(facts, 'transcript.fixedRange').end, 3);
    assert.deepEqual(environment.transcript.snapshot(), fails ? messagesBefore : [...messagesBefore, { role: 'assistant', content: '在南楼201。' }]);
    for (let index = 0; index < messagesBefore.length; index++) assert.deepEqual(environment.transcript.get(index), messagesBefore[index]);
  });
}

test('message counts accumulate independently and never enter model requests', async () => {
  const { createConversationStructure } = await import('@capix/observer-service');
  const { createBoundRuntime } = await import('@capix/server-runtime');
  const { Transcript } = await import('@capix/server-runtime');
  const entities = createEnvironment({ messages: [{ role: 'user', content: '我在北京' }] });
  const transcript = entities.transcript;
  const original = transcript.get(0);
  const requests = [];
  let fails = false;

  const runner = createConversationRunner(
    createConversationStructure(),
    entities,
    new ModelInteractions(
      new ModelSource({
        async invoke(request, purpose) {
          const loaded = JSON.parse(request.messages[1].content);
          assert.doesNotMatch(JSON.stringify(request), /selectionCount/);
          if (purpose === 'memory') return raw({ memories: [] });
          assert.deepEqual(Object.keys(loaded.message).sort(), ['content', 'role']);
          assert.ok(loaded.history.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['content', 'index', 'role'])));
          assert.equal(purpose, 'answer');
          requests.push(loaded);
          assert.ok(loaded.history.every((item) => !('selectionCount' in item)));
          if (fails) throw new Error('generation failed');
          return raw({ kind: 'answer', content: '测试回复' });
        },
      }),
    ),
  );
  const run = async () => {
    return runner.run({ messages: [{ role: 'user', content: '继续' }] }, { settings });
  };
  await run();
  assert.equal(requests.length, 1);
  assert.equal(entities.selectionUsage.get(original), 1);
  fails = true;
  await assert.rejects(run(), /generation failed/);
  assert.equal(requests.length, 2);
  assert.equal(entities.selectionUsage.get(original), 2);
  fails = false;
  const snapshot = entities.active.capture();
  assert.throws(() => entities.active.apply({ basis: snapshot.basis, messageIndexes: [0, 0], memoryIds: [] }), /unique/);
  assert.equal(entities.selectionUsage.get(original), 2);
  entities.active.apply({ basis: snapshot.basis, messageIndexes: [], memoryIds: [] });
  await run();
  assert.equal(requests.length, 3);
  assert.equal(entities.selectionUsage.get(original), 2);
  assert.deepEqual(original, { role: 'user', content: '我在北京' });
  assert.equal(transcript.get(0), original);
  assert.equal(entities.selectionUsage.get(Object.freeze({ ...original })), 0);
});
