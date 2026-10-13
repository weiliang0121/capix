import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationReplica } from '@capix/client-runtime';
import { createObservationProjection } from '../../apps/observer/.test-dist/binding/observation.js';
import { updateOverviews } from '../../apps/observer/.test-dist/binding/overview.js';
import { snapshot } from '../client/fixtures.mjs';
import { observationFixture, observationState } from '../performance/observation.mjs';

function summary(id, inputIndex, selections = []) {
  return { id, inputIndex, startedAt: '2026-10-13T00:00:00Z', status: 'running', observedOffsetMs: 0, calls: [], selections, availableMemoryIds: [], memoryChanges: [] };
}
function selectionSnapshot(id, indexes) {
  const value = snapshot('running', id);
  const operationId = `selection-${id}`;
  const start = { id: `start-${operationId}`, parentId: operationId, scopeId: id, executionId: id, callId: operationId, sequence: 2, offsetMs: 1, occurredAt: value.execution.value.startedAt, value: { type: 'call', scope: 'work' } };
  const end = { ...start, id: `end-${operationId}`, sequence: 3, offsetMs: 2, value: { type: 'return', scope: 'work' } };
  value.execution.childIds.push(operationId);
  value.operations.push({ id: operationId, parentId: id, contextId: `context-${operationId}`, executionId: id, operationInstanceId: `instance-${operationId}`, operation: 'selection', label: '选择历史', source: '', caller: 'execution', callee: 'selection', status: 'succeeded', childIds: [start.id, end.id], value: { input: {}, output: { historyIndexes: indexes }, processes: [], relationChanges: [] } });
  value.events.push(start, end);
  return value;
}

test('long conversation only reprojects the changed round and its detail/graph', () => {
  const { initial, frames } = observationFixture();
  const project = createObservationProjection();
  const transcripts = new Map();
  let replica = ObservationReplica.receive(undefined, initial);
  let view = project(observationState(replica), transcripts);
  for (const frame of frames) {
    replica = ObservationReplica.receive(replica, frame);
    const next = project(observationState(replica), transcripts);
    for (let index = 0; index < 199; index++) {
      assert.equal(next.rounds[index], view.rounds[index]);
      assert.equal(next.details.get(`execution-${index}`), view.details.get(`execution-${index}`));
      assert.equal(next.graphs.get(`execution-${index}`), view.graphs.get(`execution-${index}`));
    }
    assert.notEqual(next.rounds[199], view.rounds[199]);
    view = next;
  }
});

test('selection count deltas preserve baseline contributions and replace each affected E contribution exactly once', () => {
  const overview = { transcriptId: 'fixture-transcript', messages: [0, 1, 2].map((index) => ({ index, count: index === 0 ? 1 : 0 })), executions: [summary('historic', 0, [{ operationId: 'old', status: 'succeeded', indexes: [0] }])] };
  const first = selectionSnapshot('first', [0, 1]);
  const second = selectionSnapshot('second', [1]);
  const added = updateOverviews(overview, [first, second]);
  assert.deepEqual(
    added.messages.map((entry) => entry.count),
    [2, 2, 0],
  );
  const repeated = updateOverviews(added, [first, second]);
  assert.deepEqual(
    repeated.messages.map((entry) => entry.count),
    [2, 2, 0],
  );
  const revised = updateOverviews(repeated, [selectionSnapshot('first', [2])]);
  assert.deepEqual(
    revised.messages.map((entry) => entry.count),
    [1, 1, 1],
  );
  assert.equal(revised.executions[0], overview.executions[0]);
});

test('message append and memory source additions preserve unrelated round/detail identity', () => {
  const first = snapshot('running', 'first');
  const second = snapshot('running', 'second');
  const updates = new Map([
    ['first', first],
    ['second', second],
  ]);
  const overview = { transcriptId: 'fixture-transcript', messages: [0, 1].map((index) => ({ index, count: 0 })), executions: [summary('first', 0), summary('second', 1)] };
  const state = { enabled: true, loading: false, overview, updates, records: updates, memory: { items: [] }, transcriptRecords: [] };
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
  ];
  const transcripts = new Map([['fixture-transcript', { snapshot: { messages }, sync: { status: 'live' } }]]);
  const project = createObservationProjection();
  const initial = project(state, transcripts);
  const expanded = new Map([['fixture-transcript', { snapshot: { messages: [...messages, { role: 'assistant', content: 'second answer' }] }, sync: { status: 'live' } }]]);
  const append = { id: 'append', transcriptId: 'fixture-transcript', executionId: 'second', value: { action: 'append', start: 2, end: 3 } };
  const answeredState = { ...state, overview: { ...overview, messages: [...overview.messages, { index: 2, count: 0 }] }, transcriptRecords: [append] };
  const answered = project(answeredState, expanded);
  assert.equal(answered.rounds[0], initial.rounds[0]);
  assert.equal(answered.details.get('first'), initial.details.get('first'));
  assert.equal(answered.rounds[1].response.content, 'second answer');
  const record = { id: 'memory-record', memoryId: 'memory', executionId: 'second', value: { action: 'create', change: 'new evidence' } };
  const memorized = project({ ...answeredState, memory: { items: [{ id: 'memory', topic: 'topic', content: 'content', sources: [], records: [record] }] } }, expanded);
  assert.equal(memorized.rounds[0], answered.rounds[0]);
  assert.equal(memorized.details.get('first'), answered.details.get('first'));
  assert.notEqual(memorized.details.get('second'), answered.details.get('second'));
  assert.equal(memorized.rounds[1].memoryChanges[0].id, record.id);
});

test('all cumulative updates remain visible when several deliveries coalesce before a binding frame', () => {
  const first = snapshot('running', 'first');
  const second = snapshot('running', 'second');
  const overview = { transcriptId: 'fixture-transcript', messages: [], executions: [] };
  const project = createObservationProjection();
  const state = { enabled: true, loading: false, overview, updates: new Map(), records: new Map(), memory: { items: [] }, transcriptRecords: [] };
  project(state, new Map());
  const latest = new Map([
    ['first', first],
    ['second', second],
  ]);
  const view = project({ ...state, updates: latest, records: latest }, new Map());
  assert.deepEqual(
    view.rounds.map((round) => round.id),
    ['first', 'second'],
  );
});
