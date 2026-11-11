import assert from 'node:assert/strict';

import { test } from 'node:test';

import { validateExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';

const occurredAt = '2026-10-20T00:00:00.000Z';

const call = (id, structureKind, parentId, childIds = []) => ({ id, contextId: `${id}-context`, structureKind, parentId, childIds, status: 'running', value: { input: {}, startedAt: occurredAt, processes: [], relationChanges: [] } });

const boundary = (record, scopeId, sequence) => ({ id: `boundary-${record.id}`, parentId: record.id, callId: record.id, scopeId, sequence, occurredAt, offsetMs: sequence, value: { type: 'call', scope: 'work' } });

function snapshot() {
  const scene = call('scene', 'scene', 'recording', ['task']);
  const task = call('task', 'group', scene.id, ['leaf']);
  const leaf = call('leaf', 'node', task.id);
  return { rootCall: scene, execution: task, calls: [task, leaf], boundaries: [boundary(scene, scene.id, 1), boundary(task, scene.id, 4), boundary(leaf, scene.id, 5)], transcripts: [], memories: [], resources: [] };
}

test('callable task snapshots preserve actual tree and allow boundary sequence gaps outside the selected subtree', () => {
  validateExecutionRecordSnapshot(snapshot());
});

test('callable task snapshots reject leaf composition and cyclic or foreign parents', () => {
  const leafParent = snapshot();
  leafParent.execution.structureKind = 'node';
  assert.throws(() => validateExecutionRecordSnapshot(leafParent));
  const cycle = snapshot();
  cycle.calls[1].parentId = 'leaf';
  assert.throws(() => validateExecutionRecordSnapshot(cycle));
  const foreign = snapshot();
  foreign.calls[1].parentId = 'foreign';
  assert.throws(() => validateExecutionRecordSnapshot(foreign));
  const sceneMember = snapshot();
  sceneMember.calls[1].structureKind = 'scene';
  assert.throws(() => validateExecutionRecordSnapshot(sceneMember));
});

test('callable task snapshots reject conflicting task copies and duplicated call identities', () => {
  const conflict = snapshot();
  conflict.execution = { ...conflict.execution, status: 'succeeded' };
  assert.throws(() => validateExecutionRecordSnapshot(conflict));
  const duplicate = snapshot();
  duplicate.calls[1].contextId = duplicate.execution.contextId;
  assert.throws(() => validateExecutionRecordSnapshot(duplicate));
  const rootConflict = snapshot();
  rootConflict.calls[1].contextId = rootConflict.rootCall.id;
  assert.throws(() => validateExecutionRecordSnapshot(rootConflict));
});

test('only archived projections may contain a legacy child with no observed starting time', () => {
  const value = snapshot();
  delete value.calls[1].value.startedAt;
  value.boundaries.pop();
  assert.throws(() => validateExecutionRecordSnapshot(value));
  value.archive = { sourceId: 'old-source', revision: 7, state: 'open' };
  validateExecutionRecordSnapshot(value);
});

test('deep task projections require the complete ancestor path and its live boundaries', () => {
  const value = snapshot();
  const ancestor = call('organizer', 'group', value.rootCall.id, [value.execution.id]);
  value.rootCall.childIds = [ancestor.id];
  value.execution.parentId = ancestor.id;
  value.ancestors = [ancestor];
  value.boundaries.splice(1, 0, boundary(ancestor, value.rootCall.id, 2));
  validateExecutionRecordSnapshot(value);
  const missingPath = structuredClone(value);
  delete missingPath.ancestors;
  assert.throws(() => validateExecutionRecordSnapshot(missingPath));
  const foreignRoot = structuredClone(value);
  foreignRoot.rootCall.id = 'unrelated';
  assert.throws(() => validateExecutionRecordSnapshot(foreignRoot));
  const missingBoundary = structuredClone(value);
  missingBoundary.boundaries = missingBoundary.boundaries.filter((entry) => entry.callId !== ancestor.id);
  assert.throws(() => validateExecutionRecordSnapshot(missingBoundary));
  const missingRootBoundary = structuredClone(value);
  missingRootBoundary.boundaries.shift();
  assert.throws(() => validateExecutionRecordSnapshot(missingRootBoundary));
});

test('callable snapshots accept narrow memory display records and reject old or metadata-bearing bodies', () => {
  const value = snapshot();
  const memory = { id: 'memory-record', kind: 'memory', memoryId: 'memory', memoriesId: 'collection', sequence: 1, parentId: value.execution.id, callId: value.execution.id, contextId: value.execution.contextId, value: { action: 'create', result: { content: 'current' } } };
  value.memories.push(memory);
  validateExecutionRecordSnapshot(value);
  for (const body of [
    { action: 'create', change: 'old', sourceIndexes: [0], result: { topic: 'old', content: 'current', sourceIndexes: [0] } },
    { action: 'create', result: { content: 'current', metadata: {} } },
    { action: 'create', reason: undefined, result: { content: 'current' } },
    { action: 'delete', result: { content: 'current' } },
    { action: 'update', result: {} },
  ]) {
    memory.value = body;
    assert.throws(() => validateExecutionRecordSnapshot(value), /memory/);
  }
});
