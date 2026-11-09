import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOutput } from '@weiliang0121/capix-protocol';
import { observeMemory } from '@weiliang0121/capix-records';
import { initializeObserver, observeExecution, observeOverview, observeSelection } from '@capix/observer-service';
import { projectDetail } from '../../apps/observer/.test-dist/binding/details.js';
import { updateOverview } from '../../apps/observer/.test-dist/binding/overview.js';

const raw = (value) => ({ id: 'test', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const settings = { model: 'test', contextBudget: 1_000_000, maxOutputTokens: 1536, timeoutMs: 1000 };

test('prepared and maintained material records reference large message bodies while checkpoints retain full values', async () => {
  const history = { role: 'user', content: 'large-history-body:'.repeat(8_000) };
  const requests = [];
  const environment = initializeObserver(
    {
      async invoke(request, purpose) {
        requests.push({ request, purpose });
        return raw(purpose === 'answer' ? { kind: 'answer', content: 'answer' } : { memories: [] });
      },
    },
    [history],
    {
      maintenance: ({ material }) => ({ basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memoryIds: material.memories.map((item) => item.id) }),
    },
  );
  try {
    environment.memories.apply([{ action: 'create', memoryId: null, change: 'initial memory', sourceIndexes: [0], result: { topic: 'topic', content: 'historic memory value', sourceIndexes: [0] } }]);
    const memory = environment.memories.snapshot()[0];
    const snapshot = await observeExecution(environment.runner, environment.records.installation, { messages: [{ role: 'user', content: 'question' }] }, { settings });
    assert.equal(snapshot.execution.status, 'succeeded');
    const preparation = snapshot.calls.find((item) => item.name === 'prepareContext');
    const maintenance = snapshot.calls.filter((item) => item.name === 'maintainContext');
    assert.equal(maintenance.length, 2);
    const prepared = readOutput(preparation.value);
    assert.deepEqual(Object.keys(prepared).sort(), ['material', 'selection']);
    assert.deepEqual(Object.keys(prepared.material).sort(), ['basis', 'memories', 'messageIndexes']);
    assert.deepEqual(prepared.material.messageIndexes, [0, 1]);
    assert.deepEqual(prepared.selection, { historyIndexes: [0] });
    assert.deepEqual(prepared.material.memories, [memory]);
    const materialRecords = {
      operations: [preparation, ...maintenance],
      relations: snapshot.execution.value.relationChanges.filter((entry) => ['preparation', 'maintenance'].includes(entry.identity.key)),
    };
    assert.equal(materialRecords.relations.filter((entry) => entry.change.kind === 'accepted').length, 2);
    const recordText = JSON.stringify(materialRecords);
    assert.equal(recordText.includes('large-history-body:'), false);
    assert.ok(recordText.length < history.content.length / 2, 'new observation bodies stay independent of history text size');
    for (const record of maintenance) {
      assert.deepEqual(Object.keys(readOutput(record.value)).sort(), ['basis', 'memories', 'messageIndexes']);
      assert.deepEqual(Object.keys(record.value.input), ['phase']);
      const head = environment.checkpoints.read(record.contextId);
      assert.equal(head.image.state.input.material.messages[0].message.content, history.content);
      assert.equal(head.image.state.material.messages[0].message.content, history.content);
      assert.equal(head.delivery.output.messages[0].message.content, history.content);
    }
    const head = environment.checkpoints.read(preparation.contextId);
    assert.equal(head.image.state.material.messages[0].message.content, history.content);
    assert.equal(head.delivery.output.material.messages[0].message.content, history.content);
    assert.equal(head.delivery.output.context.selectedMessages[0].message.content, history.content);
    assert.equal(environment.checkpoints.read(snapshot.execution.contextId).image.state.prepared.material.messages[0].message.content, history.content);
    assert.ok(requests.find((entry) => entry.purpose === 'answer').request.messages.some((message) => message.content.includes(history.content)));

    const selection = observeSelection(environment.records.book, environment.transcript);
    assert.equal(selection.messages[0].count, 1);
    assert.deepEqual(selection.executions[0].selections[0].indexes, [0]);
    const overview = observeOverview(environment);
    assert.deepEqual(overview.executions[0].availableMemoryIds, [memory.id]);
    const projected = updateOverview({ transcriptId: environment.transcript.id, executions: [], messages: overview.messages.map((message) => ({ ...message, count: 0 })) }, snapshot);
    assert.equal(projected.messages[0].count, 1);
    assert.deepEqual(projected.executions[0].availableMemoryIds, [memory.id]);

    environment.memories.apply([{ action: 'update', memoryId: memory.id, change: 'later memory', sourceIndexes: [0], result: { topic: 'topic', content: 'current memory value', sourceIndexes: [0] } }]);
    const detail = projectDetail(snapshot, observeMemory(environment.memories, environment.records.book));
    assert.equal(detail.memory.incoming[0].content, 'historic memory value');
    assert.equal(detail.calls.get(preparation.id).memory.incoming[0].content, 'historic memory value');
  } finally {
    environment.close();
  }
});
