import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExecutionRecordSnapshot, validateRecordingArchives } from '@weiliang0121/capix-protocol';
import { ObservationReplica } from '@capix/client-runtime';
import { createObservationProjection } from '../../apps/observer/.test-dist/binding/observation.js';
import { projectDetail } from '../../apps/observer/.test-dist/binding/details.js';
import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';
import { formatDuration } from '../../apps/observer/.test-dist/features/explorer/layout.js';
import { snapshot, baseline } from '../client/fixtures.mjs';

const archive = { sourceId: 'old-source', revision: 4, state: 'open' };

test('archive accepts persisted boundary prefixes without weakening live snapshot checks', () => {
  const complete = snapshot('succeeded');
  const cut = { ...complete, boundaries: complete.boundaries.slice(0, 2) };
  assert.throws(() => validateExecutionRecordSnapshot(cut));
  const historical = { ...cut, archive };
  assert.doesNotThrow(() => validateExecutionRecordSnapshot(historical));
  assert.equal(projectExecution(historical).status, 'succeeded');
  assert.equal(projectExecution(historical).callSequence.calls[0].durationMs, undefined);
  assert.throws(() => validateExecutionRecordSnapshot({ ...historical, execution: { ...historical.execution, status: 'running' } }), 'archive cannot make a running record contain a final output');
  assert.throws(
    () =>
      validateExecutionRecordSnapshot({
        ...historical,
        boundaries: [
          { ...cut.boundaries[0], sequence: 2 },
          { ...cut.boundaries[1], sequence: 2 },
        ],
      }),
    'archive cannot hide duplicate sequence identities',
  );
  assert.throws(() => validateExecutionRecordSnapshot({ ...historical, archive: { ...archive, state: 'invented' } }));
});

test('just-registered historical call loads without fabricating boundaries or an outcome', () => {
  const value = snapshot('running');
  value.boundaries = [];
  assert.throws(() => validateExecutionRecordSnapshot(value));
  value.archive = archive;
  const detail = projectDetail(value, { items: [] });
  assert.equal(detail.status, 'unresolved');
  assert.equal(detail.calls.get(value.execution.id).status, 'unresolved');
  assert.equal(detail.calls.get(value.rootCall.id).status, 'unresolved');
  assert.equal(detail.calls.get(value.execution.id).durationMs, undefined);
  assert.equal(value.execution.status, 'running');
  assert.equal(formatDuration(undefined, detail.status), '耗时未取得');
});

test('archive provenance survives reception; app separates unresolved history from live calls', () => {
  const old = snapshot('running', 'old');
  const current = snapshot('running', 'current');
  const execution = (value, origin) => ({ id: value.execution.id, startedAt: value.execution.value.startedAt, status: value.execution.status, inputIndex: 0, selections: [], memoryChanges: [], availableMemoryIds: [], observedOffsetMs: 3, ...(origin ? { archive: origin } : {}), calls: [{ id: value.execution.id, contextId: value.execution.contextId, recordType: 'group', name: 'execution', label: '执行调用', source: '', status: value.execution.status, offsetMs: 0 }] });
  const overview = { transcriptId: 'transcript', messages: [], archives: [{ ...archive, rootIds: ['runtime-root'] }], executions: [execution(old, archive), execution(current)] };
  const replica = ObservationReplica.receive(undefined, baseline({ overview }));
  const project = createObservationProjection();
  const state = { overview: replica.overview, updates: new Map(), records: new Map([['old', { ...old, archive }]]), memory: { items: [] }, loading: false };
  const result = project(state, new Map());
  assert.equal(result.rounds[0].status, 'unresolved');
  assert.equal(result.rounds[1].status, 'running');
  assert.equal(result.graphs.get('old').roots[0].status, 'unresolved');
  assert.equal(result.graphs.get('current').roots[0].status, 'running');
  assert.match(result.notice, /历史记录来源未完整封存/);
  assert.equal(overview.executions[0].status, 'running');
  assert.equal(project(state, new Map()).graphs, result.graphs, 'loading transcript content does not rebuild static historical graphs');
  const invalid = { ...overview, archives: [{ ...archive, rootIds: ['a', 'a'] }] };
  assert.throws(() => ObservationReplica.receive(undefined, baseline({ overview: invalid })));
  assert.throws(() =>
    validateRecordingArchives([
      { ...archive, rootIds: ['a'] },
      { ...archive, sourceId: 'other', rootIds: ['a'] },
    ]),
  );
});

test('reconnected baseline drops stale live details before historical detail reload', () => {
  const project = createObservationProjection();
  const running = snapshot('running', 'old');
  const execution = { id: 'old', startedAt: running.execution.value.startedAt, status: 'running', inputIndex: 0, selections: [], memoryChanges: [], availableMemoryIds: [], observedOffsetMs: 0, calls: [{ id: 'old', contextId: running.execution.contextId, recordType: 'group', name: 'execution', label: '执行调用', source: '', status: 'running', offsetMs: 0 }] };
  const live = { overview: { transcriptId: 'transcript', messages: [], executions: [execution] }, updates: new Map(), records: new Map([['old', running]]), memory: { items: [] }, loading: false };
  assert.equal(project(live, new Map()).details.get('old').status, 'running');
  const restored = { ...live, overview: { ...live.overview, executions: [{ ...execution, archive }] }, records: new Map() };
  const next = project(restored, new Map());
  assert.equal(next.details.has('old'), false);
  assert.equal(next.graphs.get('old').roots[0].status, 'unresolved');
  assert.equal(next.graphs.get('old').summaryOnly, true);
});
