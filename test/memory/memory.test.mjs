import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { observeExecution } from '../../dist/server/observer/observe.js';
import { observeMemory } from '../../dist/server/memory/observe.js';
import { memoryOutputContract } from '../../dist/server/operations/memory/output.js';
import { MemoryCollection } from '../../dist/server/memory/collection.js';
import { MemoryHelper } from '../../dist/server/memory/helper.js';
import { Memory } from '../../dist/server/memory/memory.js';
import { MemoryRecord, MemoryRecordHelper, RecordBook, RuntimeRecord, RecordIndex } from '../../dist/server/records/index.js';
import { RuntimeRecorder } from '../../dist/server/records/recorder.js';
import { Transcript } from '../../dist/server/transcript/transcript.js';
import { ObserverExecution } from '../../dist/server/observer/execution.js';
import { Runtime } from '../../dist/server/runtime/runtime.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const content = (topic, value, sourceIndexes) => ({ topic, content: value, sourceIndexes });
const change = (result, explanation, indexes = result.sourceIndexes, memoryId = null) => ({ action: memoryId === null ? 'create' : 'update', memoryId, change: explanation, sourceIndexes: indexes, result });

async function run(environment, message, options = settings) {
  const input = acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content: message }] });
  return observeExecution(environment.execution, environment.recorder, input, { settings: options, transcript: environment.transcript });
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
  const memory = environment.execution.memories.values(environment.transcript)[0];
  const original = memory.snapshot();
  const firstRecord = MemoryRecordHelper.find(environment.book, memory.id)[0];
  const second = await run(environment, '聚餐改为150，键盘不变。');
  const third = await run(environment, '谢谢。');
  for (const facts of [first, second, third]) {
    assert.equal(facts.execution.status, 'succeeded');
    assert.deepEqual(
      facts.operations.map((item) => item.operation),
      ['selection', 'assemble', 'answer', 'memory'],
    );
  }
  assert.equal(requests.length, 9);
  for (let index = 0; index < requests.length; index += 3) {
    const selection = JSON.parse(requests[index].request.messages[1].content);
    const extraction = JSON.parse(requests[index + 2].request.messages[1].content);
    assert.deepEqual(selection.memories, extraction.memories);
  }
  assert.deepEqual(first.operations[0].value.input.memories, []);
  assert.equal(second.operations[0].value.input.memories[0].content, '用户聚餐预算200元。');
  assert.equal(third.operations[0].value.input.memories[0].content, '用户聚餐预算150元。');
  assert.equal(environment.execution.memories.get(memory.id), memory);
  assert.equal(environment.execution.memories.values(environment.transcript).length, 2);
  assert.equal(memory.content, '用户聚餐预算150元。');
  assert.equal(original.content, '用户聚餐预算200元。');
  assert.equal(firstRecord.value.result.content, original.content);
  const records = MemoryRecordHelper.find(environment.book, memory.id);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof MemoryRecord && record instanceof RuntimeRecord));
  assert.notEqual(records[0].id, records[1].id);
  assert.notEqual(records[0].id, memory.id);
  assert.equal(records[1].memoryId, memory.id);
  assert.equal(records[1].executionId, second.execution.id);
  const operation = second.operations.find((item) => item.operation === 'memory');
  assert.equal(records[1].operationId, operation.id);
  assert.notEqual(records[1].operationId, operation.contextId);
  assert.deepEqual(records[1].value, { action: 'update', change: '聚餐预算从200元改为150元', sourceIndexes: [2], result: content('聚餐', '用户聚餐预算150元。', [0, 2]) });
  assert.throws(() => {
    records[0].value.result.content = 'rewrite';
  }, TypeError);
  assert.throws(() => records[1].value.sourceIndexes.push(99), TypeError);
  assert.equal(environment.transcript.length, 6);
  assert.ok(environment.transcript.snapshot().every((message) => Object.keys(message).sort().join() === 'content,role'));
  const observation = observeMemory(environment.execution.memories, environment.transcript, environment.book);
  assert.equal(observation.items.length, 2);
  assert.equal(observation.items[0].records.length, 2);
  assert.equal(observation.items[0].sources[0].message, environment.transcript.get(0));
  assert.doesNotMatch(JSON.stringify(observation), /relations|supersedes|previousRecordId|nextRecordId/);
  assert.throws(() => MemoryRecordHelper.create(environment.book, operation.id, memory.id, records[1].value), /during their operation/);
});

test('the output contract rejects invalid targets, evidence, duplicate updates and the removed relation shape before applying anything', () => {
  const input = { currentIndexes: [2, 3], messages: [0, 2, 3].map((index) => ({ index, message: { role: 'user', content: 'evidence' } })), memories: [{ id: 'old', ...content('聚餐', '200', [0]) }] };
  const valid = change(content('聚餐', '150', [0, 2]), '200改150', [2], 'old');
  for (const [candidate, code] of [
    [{ ...valid, memoryId: 'foreign' }, 'MEMORY_TARGET'],
    [{ ...valid, action: 'create' }, 'MEMORY_TARGET'],
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
  const memory = environment.execution.memories.values(environment.transcript)[0];
  invalid = true;
  const facts = await run(environment, '改成150');
  assert.equal(facts.execution.status, 'failed');
  assert.equal(facts.operations.at(-1).value.error.code, 'MEMORY_SOURCE');
  assert.equal(facts.operations.find((item) => item.operation === 'answer').status, 'succeeded');
  assert.equal(environment.transcript.current('assistant').content, '正式回答');
  assert.equal(memory.content, '200');
  assert.equal(MemoryRecordHelper.find(environment.book, memory.id).length, 1);
  assert.equal(purposes.length, 6);
});

test('memory updates work without records and cannot cross Transcript boundaries or partially apply invalid batches', async () => {
  const inputs = [];
  const selectionInputs = [];
  const execution = new ObserverExecution(new Runtime(), {
    async invoke(request, purpose) {
      if (purpose === 'selection') {
        selectionInputs.push(JSON.parse(request.messages[1].content));
        return raw({ historyIndexes: [] });
      }
      if (purpose === 'answer') return raw({ kind: 'answer', content: '了解' });
      const input = JSON.parse(request.messages[1].content);
      inputs.push(input);
      const target = input.memories[0];
      const index = input.currentIndexes[0];
      return raw({ memories: [change(content('预算', String(index), [index]), target ? '修改预算' : '建立预算', [index], target?.id ?? null)] });
    },
  });
  const a = new Transcript([{ role: 'user', content: '预算150' }]);
  const b = new Transcript([{ role: 'user', content: '预算300' }]);
  await execution.call(a.current('user'), { settings, transcript: a });
  const memory = execution.memories.values(a)[0];
  a.append({ role: 'user', content: '改成200' });
  await execution.call(a.current('user'), { settings, transcript: a });
  assert.equal(execution.memories.values(a)[0], memory);
  assert.equal(memory.content, '2');
  await execution.call(b.current('user'), { settings, transcript: b });
  assert.equal(inputs[2].memories.length, 0);
  assert.deepEqual(
    selectionInputs.map((input) => input.memories.length),
    [0, 1, 0],
  );
  assert.equal(execution.memories.values(b).length, 1);
  const collection = new MemoryCollection();
  const other = collection.add(new Memory(a, content('原本', '150', [0])));
  assert.throws(() => MemoryHelper.apply(collection, b, [change(content('合法', '300', [0]), '建立'), change(content('跨域', '200', [0]), '修改', [0], other.id)]), /this Transcript/);
  assert.equal(collection.values(b).length, 0);
  assert.equal(other.content, '150');
  assert.throws(() => MemoryHelper.apply(collection, a, [change(content('更新', '200', [0]), '修改', [0], other.id), change(content('坏来源', '300', [99]), '建立')]), RangeError);
  assert.equal(other.content, '150');
});

test('recording observes the actual changed fact; registration failure propagates without pretending that mutation was rolled back', async () => {
  class RejectMemoryBook extends RecordBook {
    add(record) {
      if (record instanceof MemoryRecord) throw new Error('memory record registration failed');
      return super.add(record);
    }
  }
  const book = new RejectMemoryBook();
  const recorder = new RuntimeRecorder(book, new RecordIndex((r) => r.executionId), new RecordIndex((r) => r.operationId), new RecordIndex((r) => r.executionId));
  const execution = new ObserverExecution(new Runtime(recorder), {
    async invoke(_request, purpose) {
      if (purpose === 'selection') return raw({ historyIndexes: [] });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '了解' });
      return raw({ memories: [change(content('预算', '150', [0]), '建立预算150')] });
    },
  });
  const transcript = new Transcript([{ role: 'user', content: '预算150' }]);
  await assert.rejects(execution.call(transcript.current('user'), { settings, transcript }), /registration failed/);
  const memory = execution.memories.values(transcript)[0];
  assert.equal(memory.content, '150');
  assert.equal(MemoryRecordHelper.find(book, memory.id).length, 0);
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
  assert.deepEqual(purposes, ['selection', 'answer']);
  assert.equal(facts.operations.at(-1).value.error.code, 'CAPACITY_EXCEEDED');
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.execution.memories.values(environment.transcript).length, 0);
});

test('selection capacity includes previous memories and rejects overflow before any provider call', async () => {
  const environment = initializeObserver({
    async invoke() {
      assert.fail('oversized selection must not call provider');
    },
  });
  environment.transcript.append({ role: 'user', content: '旧条件' }, { role: 'assistant', content: '已了解' });
  const memory = environment.execution.memories.add(new Memory(environment.transcript, content('大量理解', '历史条件。'.repeat(10000), [0])));
  const facts = await run(environment, '继续', { ...settings, contextBudget: 2000 });
  assert.equal(facts.execution.status, 'failed');
  assert.equal(facts.operations.length, 1);
  assert.equal(facts.operations[0].value.error.code, 'CAPACITY_EXCEEDED');
  assert.equal(facts.operations[0].value.input.memories[0].content, memory.content);
  assert.equal(environment.transcript.length, 3);
});
