import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcript, Memories } from '@capix/server-runtime/content';
import { RecordBook, Recorder, CallableRecord, OperationRecord, MemoryRecord, ResourceRecord, ExecutionRecordHelper, OperationRecordHelper, AttemptRecordHelper, observeMemory } from '@capix/server-runtime/recording';
import { initializeObserver, observeOverview } from '@capix/observer-service';
import { createRecordScope } from '../fixtures/runtime.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 2048, timeoutMs: 1000 };

test('overview groups long-conversation operation ownership without rescanning every call for each execution', async (t) => {
  const environment = initializeObserver({
    async invoke(_request, purpose) {
      const value = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: 'answer' } : { memories: [] };
      return { id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null };
    },
  });
  try {
    for (let index = 0; index < 16; index++) await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: `question ${index}` }] }, { settings });
    const expected = observeOverview(environment);
    const records = [...environment.book.values()];
    let ownershipReads = 0;
    const projected = records.map(
      (record) =>
        new Proxy(record, {
          get(target, key) {
            if (target instanceof CallableRecord && key === 'parentId') ownershipReads++;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    const scans = t.mock.method(environment.book, 'values', () => projected.values());
    assert.deepEqual(observeOverview(environment), expected);
    const operations = records.filter((record) => record instanceof CallableRecord).length;
    assert.ok(ownershipReads <= operations * 6, `${ownershipReads} ownership reads for ${operations} operations`);
    assert.equal(scans.mock.callCount(), 3, 'execution transcript ranges must use direct resource ownership, without scanning the entire book');
  } finally {
    environment.consumer.close();
  }
});

test('memory observation scans available records once across many independent memories', (t) => {
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  const memories = new Memories(transcript);
  memories.apply(Array.from({ length: 32 }, (_, index) => ({ action: 'create', memoryId: null, change: 'new evidence', sourceIndexes: [0], result: { topic: `topic ${index}`, content: `content ${index}`, sourceIndexes: [0] } })));
  const book = new RecordBook();
  const values = t.mock.method(book, 'values');
  const observed = observeMemory(memories, book);
  assert.equal(observed.items.length, 32);
  assert.equal(values.mock.callCount(), 1);
  assert.ok(observed.items.every((item) => item.records.length === 0 && item.sources[0].transcriptId === transcript.id));
});

test('restored memory identities keep empty and populated record groups independent of object prototype names', () => {
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  const ids = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  const memories = Memories.restore({ id: 'memories', transcriptId: transcript.id, sequence: ids.length, items: ids.map((id) => ({ id, topic: 'topic', content: id, sourceIndexes: [0] })) }, transcript);
  const book = new RecordBook();
  assert.ok(observeMemory(memories, book).items.every((item) => item.records.length === 0));
  const recorded = ['constructor', '__proto__', '__proto__'].map((memoryId, index) => book.add(new MemoryRecord({ memoryId, memoriesId: memories.id, sequence: index + 1 }, { action: 'create', change: 'evidence', sourceIndexes: [0], result: { topic: 'topic', content: memoryId, sourceIndexes: [0] } })));
  const observed = observeMemory(memories, book);
  assert.deepEqual(
    observed.items.map((item) => [item.id, item.records.map((record) => record.id)]),
    [
      ['constructor', [recorded[0].id]],
      ['toString', []],
      ['__proto__', [recorded[1].id, recorded[2].id]],
      ['hasOwnProperty', []],
    ],
  );
});

test('restored execution identities keep absent and populated overview groups independent of object prototype names', () => {
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  for (const populated of [false, true]) {
    const recorder = new Recorder(new RecordBook());
    const runtime = createRecordScope(recorder);
    const execution = ExecutionRecordHelper.create(recorder, { contextId: 'execution-context', parentId: runtime.id }, { input: null, settings: {} });
    for (const [index, phase] of ['bound', 'available'].entries()) recorder.add(new ResourceRecord({ parentId: execution.id, access: 'transcript.fixedRange', supplyId: 'transcript', sequence: index + 1, occurredAt: recorder.clock.now(), phase }, { transcriptId: transcript.id, start: 0, end: 1 }));
    if (populated) {
      const operation = OperationRecordHelper.create(recorder, { executionId: execution.id, contextId: 'operation-context', operationInstanceId: 'instance', operation: 'fixture', label: 'Fixture', source: 'fixture', caller: 'execution', callee: 'operation' }, null);
      const attempt = AttemptRecordHelper.create(recorder, { operationId: operation.id, contextId: 'attempt-context', name: 'fixture', label: 'Fixture', source: 'fixture', caller: 'operation', callee: 'processing' }, null);
      recorder.add(new MemoryRecord({ memoryId: 'memory', memoriesId: 'memories', sequence: 1, source: { executionId: execution.id, operationId: operation.id, contextId: attempt.contextId, callId: attempt.id } }, { action: 'create', change: 'evidence', sourceIndexes: [0], result: { topic: 'topic', content: 'memory', sourceIndexes: [0] } }));
    }
    const state = recorder.book.exportState();
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const restored = RecordBook.restore(JSON.parse(JSON.stringify(state, (_key, value) => (value === execution.id ? id : value))));
      const overview = observeOverview({ book: restored, transcript });
      assert.equal(overview.executions.length, 1);
      assert.equal(overview.executions[0].id, id);
      assert.deepEqual(
        overview.executions[0].calls.map((call) => call.recordType),
        populated ? ['group', 'group', 'node'] : ['group'],
      );
      assert.equal(overview.executions[0].memoryChanges.length, populated ? 1 : 0);
    }
  }
});
