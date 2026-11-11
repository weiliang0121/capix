import assert from 'node:assert/strict';

import { test } from 'node:test';

import { validateExecutionRecordSnapshot } from '@weiliang0121/capix-records/data';

const occurredAt = '2026-10-20T00:00:00.000Z';

const call = (id, structureKind, parentId, childIds = []) => ({ id, contextId: `${id}-context`, structureKind, parentId, childIds, status: 'running', value: { input: {}, startedAt: occurredAt, processes: [], relationChanges: [] } });

const boundary = (record, scopeId, sequence) => ({ id: `boundary-${record.id}`, parentId: record.id, callId: record.id, scopeId, sequence, occurredAt, offsetMs: sequence, value: { type: 'call', scope: 'work' } });

function snapshot() {
  const scene = call('scene', 'scene', 'recording', ['task']);
  const task = call('task', 'group', scene.id, ['leaf']);
  const leaf = call('leaf', 'node', task.id);
  return { rootCall: scene, execution: task, calls: [task, leaf], boundaries: [boundary(scene, scene.id, 1), boundary(task, scene.id, 4), boundary(leaf, scene.id, 5)], transcripts: [], memories: [], resources: [] };
}

test('callable subtree snapshots preserve actual tree and allow boundary sequence gaps outside the selected subtree', () => {
  validateExecutionRecordSnapshot(snapshot());
});

test('callable subtree snapshots reject leaf composition and cyclic or foreign parents', () => {
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

test('callable subtree snapshots reject conflicting task copies and duplicated call identities', () => {
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

test('deep subtree projections require the complete ancestor path and its live boundaries', () => {
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

test('plain data entry owns output and archive validation without importing Node or entity implementations', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, relative, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = fileURLToPath(new URL('../dist/data/', import.meta.url));
  const seen = new Set();
  async function inspect(file) {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(!relative(directory, file).startsWith('..'), `${file} must remain within the data entry`);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(['"])([^'"]+)\1/g)) {
      const specifier = match[2];
      if (!specifier.startsWith('.')) {
        assert.ok(file.endsWith('.d.ts') && specifier === '@weiliang0121/capix-contracts', `plain data cannot import ${specifier}`);
        continue;
      }
      await inspect(resolve(dirname(file), file.endsWith('.d.ts') ? specifier.replace(/\.js$/, '.d.ts') : specifier));
    }
  }
  await inspect(resolve(directory, 'index.js'));
  await inspect(resolve(directory, 'index.d.ts'));
  const data = await import('@weiliang0121/capix-records/data');
  for (const name of ['readOutput', 'validateInvocationRecordValue', 'validateExecutionRecordSnapshot', 'validateLegacyExecutionRecordSnapshot', 'validateMemoryRecordValue', 'validateRecordingArchiveOrigin', 'validateRecordingArchives']) assert.equal(typeof data[name], 'function');
  for (const name of ['BaseRecord', 'CallableRecord', 'RecordBook', 'Recorder', 'Runner', 'Selection', 'Environment', 'ObserverOverview']) assert.equal(name in data, false);
  const archive = { sourceId: 'recorded-source', rootIds: ['root'], revision: 3, state: 'sealed' };
  data.validateRecordingArchives([archive]);
  for (const archives of [[archive, archive], [{ ...archive, rootIds: ['root', 'root'] }], [{ ...archive, revision: -1 }], [{ ...archive, state: 'unknown' }], [{ ...archive, rootIds: [''] }]]) assert.throws(() => data.validateRecordingArchives(archives));
});

test('local output references retain direct previous-process validation through the data entry', async () => {
  const { readOutput, validateInvocationRecordValue } = await import('@weiliang0121/capix-records/data');
  const body = {
    input: 'request',
    processes: [
      { sequence: 1, eventSequence: 1, round: 1, occurredAt, offsetMs: 0, stage: 'execute', type: 'start', input: 'request' },
      { sequence: 2, eventSequence: 2, round: 1, occurredAt, offsetMs: 1, stage: 'execute', type: 'return', output: { content: 'result' } },
      { sequence: 3, eventSequence: 3, round: 1, occurredAt, offsetMs: 2, stage: 'receive', type: 'return', resultOf: 2 },
    ],
    relationChanges: [],
    resultOf: 2,
  };
  validateInvocationRecordValue(body, 'owner-context');
  assert.equal(readOutput(body), body.processes[1].output);
  for (const resultOf of [1, 3, 4, 0, NaN]) assert.throws(() => readOutput({ ...body, resultOf }));
  assert.throws(() => readOutput({ ...body, output: body.processes[1].output }));
  const chain = structuredClone(body);
  chain.processes.push({ ...chain.processes[2], sequence: 4, eventSequence: 4, offsetMs: 3, resultOf: 3 });
  chain.resultOf = 3;
  assert.throws(() => validateInvocationRecordValue(chain, 'owner-context'));
  const foreignRound = structuredClone(body);
  foreignRound.processes[2].round = 2;
  assert.throws(() => validateInvocationRecordValue(foreignRound, 'owner-context'));
});

test('resource record projections allow shared-fact sequence gaps while preserving exact identity and operation pairing', () => {
  const value = snapshot();
  const owner = value.execution;
  value.resources = ['bound', 'available', 'started', 'returned'].map((phase, index) => ({ id: `resource-${index}`, parentId: owner.id, access: 'notes.write', supplyId: 'notes', sequence: [1, 2, 3, 5][index], occurredAt, phase, ...(['started', 'returned'].includes(phase) ? { interactionId: 'write' } : {}), value: {} }));
  validateExecutionRecordSnapshot(value);
  for (const mutate of [
    (resources) => {
      resources[3].sequence = 3;
    },
    (resources) => {
      resources[3].sequence = 2;
    },
    (resources) => {
      resources[0].sequence = 0;
    },
    (resources) => {
      resources[3].sequence = NaN;
    },
    (resources) => {
      resources[3].sequence = Infinity;
    },
    (resources) => {
      resources[3].sequence = 4.5;
    },
    (resources) => {
      resources[3].id = resources[2].id;
    },
    (resources) => {
      resources[3].parentId = value.calls[1].id;
    },
    (resources) => {
      resources[3].supplyId = 'other';
    },
    (resources) => {
      resources[3].interactionId = 'other';
    },
    (resources) => {
      resources[2].phase = 'returned';
    },
    (resources) => {
      resources[1].phase = 'bound';
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid.resources);
    assert.throws(() => validateExecutionRecordSnapshot(invalid));
  }
});
