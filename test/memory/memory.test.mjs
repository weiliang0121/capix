import { Driver } from '@capix/server-runtime';
import { ModelInteractions, ModelSource, ActiveContent } from '@capix/observer-service';
import { readOutput } from '@capix/protocol';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver, acceptConversationInput, observeExecution, memoryOutputContract, buildConversation, createConversationStructure } from '@capix/observer-service';

import { observeMemory, Memories, Memory, MemoryRecord, MemoryRecordHelper, RecordBook, BaseRecord, Recorder, Transcript, SelectionUsage, bindRecording } from '@capix/server-runtime';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const content = (topic, value, sourceIndexes) => ({ topic, content: value, sourceIndexes });
const change = (result, explanation, indexes = result.sourceIndexes, memoryId = null) => ({ action: memoryId === null ? 'create' : 'update', memoryId, change: explanation, sourceIndexes: indexes, result });

async function run(environment, message, options = settings) {
  return observeExecution(environment.driver, environment.scene, environment.recording, { messages: [{ role: 'user', content: message }] }, { settings: options });
}

test('updates preserve Memory identity while immutable MemoryRecords describe each applied change and its actual operation', async () => {
  const requests = [];
  let round = 0;
  const environment = initializeObserver({
    async invoke(request, purpose) {
      requests.push({ request, purpose });
      const input = JSON.parse(request.messages[1].content);
      if (purpose === 'selection') {
        if (round === 0) assert.deepEqual(input.memories, []);
        else {
          assert.equal(input.memories.length, 2);
          assert.equal(input.memories.find((memory) => memory.topic === '聚餐').content, round === 1 ? '用户聚餐预算200元。' : '用户聚餐预算150元。');
        }
        assert.ok(input.history.every((message) => Object.keys(message).sort().join() === 'content,index,role'));
        return raw({ historyIndexes: input.history.map((item) => item.index) });
      }
      if (purpose === 'answer') {
        assert.equal(input.memories.length, round === 0 ? 0 : 2);
        return raw({ kind: 'answer', content: '已了解你的安排。' });
      }
      assert.equal(environment.transcript.current('assistant').content, '已了解你的安排。');
      round++;
      if (round === 1) return raw({ memories: [change(content('聚餐', '用户聚餐预算200元。', [0]), '建立聚餐安排，预算200元'), change(content('键盘', '用户键盘预算300元。', [0]), '建立键盘需求，预算300元')] });
      assert.equal(input.memories.length, 2);
      const previous = input.memories.find((memory) => memory.topic === '聚餐');
      if (round === 2) {
        assert.deepEqual(input.currentIndexes, [2, 3]);
        assert.ok(input.messages.some((message) => message.index === 0));
        return raw({ memories: [change(content('聚餐', '用户聚餐预算150元。', [0, 2]), '聚餐预算从200元改为150元', [2], previous.id)] });
      }
      assert.equal(previous.content, '用户聚餐预算150元。');
      assert.ok(!('records' in previous));
      return raw({ memories: [] });
    },
  });
  const first = await run(environment, '聚餐预算200元，键盘预算300元。');
  const memory = environment.memories.values()[0];
  const original = memory.snapshot();
  const firstRecord = MemoryRecordHelper.find(environment.book, memory.id)[0];
  const second = await run(environment, '聚餐改为150，键盘不变。');
  const third = await run(environment, '谢谢。');
  for (const facts of [first, second, third]) {
    assert.equal(facts.execution.status, 'succeeded');
    assert.deepEqual(
      facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).map((item) => item.name),
      ['prepareContext', 'conversationDecision', 'answer', 'requestModel', 'conversationDecision', 'memory', 'requestModel'],
    );
    const decisions = facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).filter((item) => item.name === 'conversationDecision');
    assert.deepEqual(
      decisions.map((record) => readOutput(record.value).kind),
      ['invoke', 'finish'],
    );
    assert.ok(
      decisions.every((record) => !facts.calls.filter((item) => item.structureKind === 'node').some((attempt) => attempt.parentId === record.id)),
      'ordinary routing does not make additional model calls',
    );
  }
  assert.equal(requests.length, 6);
  for (let index = 0; index < requests.length; index += 2) {
    const selection = JSON.parse(requests[index].request.messages[1].content);
    const extraction = JSON.parse(requests[index + 1].request.messages[1].content);
    assert.deepEqual(selection.memories, extraction.memories);
  }
  assert.deepEqual(readOutput(first.calls.filter((item) => item.structureKind === 'group' && item.id !== first.execution.id).find((record) => record.name === 'prepareContext').value).material.memories, []);
  assert.equal(readOutput(second.calls.filter((item) => item.structureKind === 'group' && item.id !== second.execution.id).find((record) => record.name === 'prepareContext').value).material.memories[0].content, '用户聚餐预算200元。');
  assert.equal(readOutput(third.calls.filter((item) => item.structureKind === 'group' && item.id !== third.execution.id).find((record) => record.name === 'prepareContext').value).material.memories[0].content, '用户聚餐预算150元。');
  assert.equal(environment.memories.get(memory.id), memory);
  assert.equal(environment.memories.values().length, 2);
  assert.equal(memory.content, '用户聚餐预算150元。');
  assert.equal(original.content, '用户聚餐预算200元。');
  assert.equal(firstRecord.value.result.content, original.content);
  const records = MemoryRecordHelper.find(environment.book, memory.id);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof MemoryRecord && record instanceof BaseRecord));
  assert.notEqual(records[0].id, records[1].id);
  assert.notEqual(records[0].id, memory.id);
  assert.equal(records[1].memoryId, memory.id);
  assert.equal(records[1].executionId, undefined, 'generic records locate their task through the real parent tree');
  const operation = second.calls.filter((item) => item.structureKind === 'group' && item.id !== second.execution.id).find((item) => item.name === 'memory');
  const applied = second.calls.find((call) => call.name === 'applyMemory' && call.parentId === operation.id);
  assert.equal(records[1].callId, applied.id);
  assert.equal(records[1].parentId, applied.id);
  assert.notEqual(records[1].parentId, operation.contextId);
  assert.deepEqual(records[1].value, { action: 'update', change: '聚餐预算从200元改为150元', sourceIndexes: [2], result: content('聚餐', '用户聚餐预算150元。', [0, 2]) });
  assert.throws(() => {
    records[0].value.result.content = 'rewrite';
  }, TypeError);
  assert.throws(() => records[1].value.sourceIndexes.push(99), TypeError);
  assert.equal(environment.transcript.length, 6);
  assert.ok(environment.transcript.snapshot().every((message) => Object.keys(message).sort().join() === 'content,role'));
  const observation = observeMemory(environment.memories, environment.book);
  assert.equal(observation.items.length, 2);
  assert.equal(observation.items[0].records.length, 2);
  assert.deepEqual(observation.items[0].sources[0], { transcriptId: environment.transcript.id, index: 0 });
  assert.doesNotMatch(JSON.stringify(observation), /relations|supersedes|previousRecordId|nextRecordId/);
  assert.equal(typeof memory.update, 'undefined');
});

test('the output contract rejects invalid targets, evidence, duplicate updates and the removed relation shape before applying anything', () => {
  const input = { currentIndexes: [2, 3], messages: [0, 2, 3].map((index) => ({ index, message: { role: 'user', content: 'evidence' } })), memories: [{ id: 'old', ...content('聚餐', '200', [0]) }] };
  const valid = change(content('聚餐', '150', [0, 2]), '200改150', [2], 'old');
  for (const [candidate, code] of [
    [{ ...valid, memoryId: 'foreign' }, 'MEMORY_TARGET'],
    [{ ...valid, action: 'create' }, 'OUTPUT_SHAPE'],
    [{ ...valid, sourceIndexes: [0] }, 'MEMORY_SOURCE'],
    [{ ...valid, sourceIndexes: [99] }, 'MEMORY_SOURCE'],
    [{ ...valid, result: content('聚餐', '150', [0]) }, 'MEMORY_SOURCE'],
    [{ ...valid, change: ' ' }, 'OUTPUT_SHAPE'],
    [{ ...valid, relations: [] }, 'OUTPUT_SHAPE'],
    [{ topic: '旧格式', content: '150', sourceIndexes: [2], relations: [] }, 'OUTPUT_SHAPE'],
  ]) {
    assert.throws(
      () => memoryOutputContract.accept({ memories: [candidate] }, input),
      (error) => error.code === code,
    );
  }
  assert.throws(
    () => memoryOutputContract.accept({ memories: [valid, valid] }, input),
    (error) => error.code === 'MEMORY_TARGET',
  );
  const accepted = memoryOutputContract.accept({ memories: [valid] }, input);
  valid.result.sourceIndexes.push(100);
  assert.deepEqual(accepted.memories[0].result.sourceIndexes, [0, 2]);
  assert.deepEqual(memoryOutputContract.accept({ memories: [] }, input), { memories: [] });
});

test('failed extraction leaves current memory and its records unchanged and keeps the generated response', async () => {
  const purposes = [];
  let invalid = false;
  const environment = initializeObserver({
    async invoke(request, purpose) {
      purposes.push(purpose);
      if (purpose === 'selection') return raw({ historyIndexes: [] });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '正式回答' });
      const input = JSON.parse(request.messages[1].content);
      if (!invalid) return raw({ memories: [change(content('聚餐', '200', [0]), '创建预算200')] });
      return raw({ memories: [change(content('聚餐', '150', [0, 2]), '200改150', [2], input.memories[0].id), change(content('无效', '未知来源', [99]), '创建无效')] });
    },
  });
  await run(environment, '预算200');
  const memory = environment.memories.values()[0];
  invalid = true;
  const facts = await run(environment, '改成150');
  assert.equal(facts.execution.status, 'failed');
  assert.equal(facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).find((item) => item.name === 'memory').value.error.code, 'MEMORY_SOURCE');
  assert.equal(facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).find((item) => item.name === 'answer').status, 'succeeded');
  assert.equal(environment.transcript.current('assistant').content, '正式回答');
  assert.equal(memory.content, '200');
  assert.equal(MemoryRecordHelper.find(environment.book, memory.id).length, 1);
  assert.equal(purposes.length, 4);
});

test('memory changes without records preserve identity, isolate scopes and reject complete invalid batches', () => {
  const a = new Memories(new Transcript([{ role: 'user', content: '预算150' }]));
  const b = new Memories(new Transcript([{ role: 'user', content: '预算300' }]));
  const [memory] = a.apply([change(content('预算', '150', [0]), '建立')]);
  const original = memory.snapshot();
  a.apply([change(content('预算', '200', [0]), '调整', [0], memory.id)]);
  assert.equal(a.get(memory.id), memory);
  assert.equal(original.content, '150');
  assert.equal(memory.content, '200');
  assert.throws(() => b.apply([change(content('合法', '300', [0]), '建立'), change(content('跨域', '200', [0]), '修改', [0], memory.id)]), /this Runtime/);
  assert.equal(b.values().length, 0);
  assert.throws(() => a.apply([change(content('预算', '400', [0]), '修改', [0], memory.id), change(content('坏来源', '300', [99]), '建立')]), RangeError);
  assert.equal(memory.content, '200');
  assert.equal(typeof memory.update, 'undefined');
  assert.equal(typeof a.add, 'undefined');
});

test('recording observes the actual changed fact; registration failure propagates without pretending that mutation was rolled back', async () => {
  class RejectMemoryBook extends RecordBook {
    add(record) {
      if (record instanceof MemoryRecord) throw new Error('memory record registration failed');
      return super.add(record);
    }
  }
  const book = new RejectMemoryBook();
  const recorder = new Recorder(book);
  const recording = bindRecording(recorder, { failure: 'propagate' });
  const transcript = new Transcript([], { observation: recording.transcript });
  const memories = new Memories(transcript, { observation: recording.memory });
  const driver = new Driver({ observations: [recording] });
  const scene = buildConversation(
    driver,
    createConversationStructure(),
    { transcript, memories, active: new ActiveContent(transcript, memories), selectionUsage: new SelectionUsage() },
    new ModelInteractions(
      new ModelSource({
        async invoke(_request, purpose) {
          if (purpose === 'selection') return raw({ historyIndexes: [] });
          if (purpose === 'answer') return raw({ kind: 'answer', content: '了解' });
          return raw({ memories: [change(content('预算', '150', [0]), '建立预算150')] });
        },
      }),
    ),
  );
  await assert.rejects(driver.run(scene, { messages: [{ role: 'user', content: '预算150' }] }, { settings }), (error) => error.code === 'OBSERVATION_FAILED' && error.cause.message === 'memory record registration failed');
  const memory = memories.values()[0];
  assert.equal(memory.content, '150');
  assert.equal(MemoryRecordHelper.find(book, memory.id).length, 0);
  const operation = [...book.values()].find((record) => record.name === 'memory');
  const accepted = [...book.values()].find((record) => record.parentId === operation.id && record.name === 'acceptModelOutput');
  const applied = [...book.values()].find((record) => record.parentId === operation.id && record.name === 'applyMemory');
  assert.equal(accepted.status, 'succeeded');
  assert.equal(readOutput(accepted.value).memories.length, 1);
  assert.equal(applied.status, 'running'); // The observer lost a fact and cannot finish this record.
  const returned = operation.value.relationChanges.find((entry) => entry.childId === applied.id && entry.change.kind === 'returned');
  assert.equal(returned.change.result.status, 'failed');
  assert.equal(returned.change.result.failure.kind, 'error');
  assert.deepEqual(applied.value.input, readOutput(accepted.value));
});

test('invalid memory output stops at acceptance without invoking application or losing the answer', async () => {
  const invalid = raw({ memories: [{}] });
  const environment = initializeObserver({
    async invoke(_request, purpose) {
      if (purpose === 'selection') return raw({ historyIndexes: [] });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '已收到' });
      return invalid;
    },
  });
  const snapshot = await run(environment, '记住这个安排');
  const extraction = snapshot.calls.filter((item) => item.structureKind === 'group' && item.id !== snapshot.execution.id).find((operation) => operation.name === 'memory');
  const attempts = snapshot.calls.filter((item) => item.structureKind === 'node').filter((attempt) => attempt.parentId === extraction.id);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.name, attempt.status]),
    [
      ['prepareModelRequest', 'succeeded'],
      ['acceptModelOutput', 'failed'],
    ],
  );
  const requested = snapshot.calls.filter((item) => item.structureKind === 'group' && item.id !== snapshot.execution.id).find((operation) => operation.parentId === extraction.id && operation.name === 'requestModel');
  assert.equal(requested.status, 'succeeded');
  assert.deepEqual(readOutput(requested.value), invalid);
  const invoked = snapshot.calls.filter((item) => item.structureKind === 'node').find((attempt) => attempt.parentId === requested.id);
  assert.equal(invoked.name, 'invokeModel');
  assert.equal(readOutput(invoked.value).kind, 'received');
  assert.deepEqual(readOutput(invoked.value).output, invalid);
  const rejection = extraction.value.error;
  assert.equal(rejection.code, 'MODEL_OUTPUT_REJECTED');
  assert.equal(rejection.cause.code, 'OUTPUT_SHAPE');
  assert.ok(rejection.cause.detail.issues.length > 0);
  assert.deepEqual(rejection.detail, { code: 'OUTPUT_SHAPE', output: invalid });
  assert.deepEqual(rejection, attempts.at(-1).value.error);
  assert.equal(extraction.value.failure.kind, 'exception');
  assert.equal(environment.memories.values().length, 0);
  assert.equal(environment.transcript.current('assistant').content, '已收到');
});

test('memory capacity overflow stops postprocessing without truncating evidence or inventing records', async () => {
  const purposes = [];
  const environment = initializeObserver({
    async invoke(_request, purpose) {
      purposes.push(purpose);
      if (purpose === 'selection') return raw({ historyIndexes: [] });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '很长的已生成回答。'.repeat(2000) });
      assert.fail('oversized extraction must not call provider');
    },
  });
  const facts = await run(environment, '请回答。', { ...settings, contextBudget: 16000 });
  assert.deepEqual(purposes, ['answer']);
  assert.equal(facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).at(-1).value.error.code, 'CAPACITY_EXCEEDED');
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.memories.values().length, 0);
});

test('answer capacity includes active memories and rejects overflow before any provider call', async () => {
  const environment = initializeObserver({
    async invoke() {
      assert.fail('oversized selection must not call provider');
    },
  });
  environment.transcript.append({ role: 'user', content: '旧条件' }, { role: 'assistant', content: '已了解' });
  const memory = environment.memories.apply([{ action: 'create', memoryId: null, change: '接纳初始记忆', sourceIndexes: [0], result: content('大量理解', '历史条件。'.repeat(10000), [0]) }])[0];
  const facts = await run(environment, '继续', { ...settings, contextBudget: 2000 });
  assert.equal(facts.execution.status, 'failed');
  const answer = facts.calls.filter((item) => item.structureKind === 'group' && item.id !== facts.execution.id).find((operation) => operation.name === 'answer');
  assert.equal(answer.value.error.code, 'CAPACITY_EXCEEDED');
  assert.equal(answer.value.input.memories[0].content, memory.content);
  assert.equal(environment.transcript.length, 3);
});
