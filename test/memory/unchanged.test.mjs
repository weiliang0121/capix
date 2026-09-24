import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryOutputContract } from '../../dist/server/operations/memory/output.js';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { observeExecution } from '../../dist/server/observer/observe.js';
import { MemoryRecordHelper } from '../../dist/server/records/index.js';

const previous = { id: 'old', topic: '键盘', content: '预算300', sourceIndexes: [0] };
const input = { currentIndexes: [2, 3], messages: [0, 2, 3].map((index) => ({ index, message: { role: 'user', content: '原文' } })), memories: [previous] };
const unchanged = { action: 'update', memoryId: 'old', change: '没有变化，保留', sourceIndexes: [0], result: { topic: previous.topic, content: previous.content, sourceIndexes: [0] } };
const accept = (memories) => memoryOutputContract.accept({ memories }, input);

test('only exact unchanged updates are skipped, after validating their shape, target and references', () => {
  assert.deepEqual(accept([unchanged]), { memories: [] });
  for (const [candidate, code] of [
    [{ ...unchanged, memoryId: 'missing' }, 'MEMORY_TARGET'],
    [{ ...unchanged, sourceIndexes: [99] }, 'MEMORY_SOURCE'],
    [{ ...unchanged, sourceIndexes: [2] }, 'MEMORY_SOURCE'],
    [{ ...unchanged, change: '' }, 'OUTPUT_SHAPE'],
    [{ ...unchanged, result: { ...unchanged.result, content: '预算 300' } }, 'MEMORY_SOURCE'],
    [{ ...unchanged, result: { ...unchanged.result, topic: '办公键盘' } }, 'MEMORY_SOURCE'],
  ])
    assert.throws(
      () => accept([candidate]),
      (error) => error.code === code,
    );
  const evidenceUpdate = { ...unchanged, sourceIndexes: [2], result: { ...unchanged.result, sourceIndexes: [0, 2] } };
  assert.deepEqual(accept([evidenceUpdate]).memories, [evidenceUpdate]);
  assert.throws(
    () => accept([unchanged, unchanged]),
    (error) => error.code === 'MEMORY_TARGET',
  );
  assert.throws(
    () => accept([unchanged, evidenceUpdate]),
    (error) => error.code === 'MEMORY_TARGET',
  );
  assert.deepEqual(input.memories, [previous]);
});

test('a real change and an unchanged update complete together; only the change is applied and recorded', async () => {
  let round = 0;
  const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
  const environment = initializeObserver({
    async invoke(request, purpose) {
      const loaded = JSON.parse(request.messages[1].content);
      if (purpose === 'selection') return raw({ historyIndexes: loaded.history.map((message) => message.index) });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '已了解' });
      round++;
      if (round === 1) return raw({ memories: ['预演', '键盘'].map((topic) => ({ action: 'create', memoryId: null, change: '建立理解', sourceIndexes: [0], result: { topic, content: topic === '预演' ? '可用链接' : '预算300', sourceIndexes: [0] } })) });
      return raw({ memories: loaded.memories.map(({ id, ...result }) => (result.topic === '预演' ? { action: 'update', memoryId: id, change: '预演改为离线包', sourceIndexes: [2], result: { ...result, content: '使用离线包', sourceIndexes: [0, 2] } } : { action: 'update', memoryId: id, change: '本轮没有新增信息，保留', sourceIndexes: [0], result })) });
    },
  });
  const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
  const run = (content) => observeExecution(environment.execution, environment.recorder, acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content }] }), { settings, transcript: environment.transcript });
  await run('内部预演可用链接，键盘预算300。');
  const keyboard = environment.execution.memories.values(environment.transcript).find((memory) => memory.topic === '键盘');
  const keyboardContent = keyboard.snapshot();
  const facts = await run('预演也改为离线包，键盘没变化。');
  assert.equal(facts.execution.status, 'succeeded');
  const operation = facts.operations.find((item) => item.operation === 'memory');
  assert.equal(operation.value.output.memories.length, 1);
  assert.equal(operation.value.output.memories[0].result.content, '使用离线包');
  const commit = facts.attempts.find((item) => item.operationId === operation.id && item.phase === 'commit');
  assert.equal(JSON.parse(commit.value.output.content).memories.length, 2);
  assert.equal(keyboard.snapshot(), keyboardContent);
  assert.equal(MemoryRecordHelper.find(environment.book, keyboard.id).length, 1);
  const rehearsal = environment.execution.memories.values(environment.transcript).find((memory) => memory.topic === '预演');
  assert.equal(rehearsal.content, '使用离线包');
  assert.equal(MemoryRecordHelper.find(environment.book, rehearsal.id).length, 2);
});
