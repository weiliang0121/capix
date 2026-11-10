import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RecordBook, Recorder, BaseRecord, CompositeRecord, RecordingRootRecord, RuntimeCallRecord, ExecutionRecord, OperationRecord, AttemptRecord, InvocationBoundaryRecord, TranscriptRecord, MemoryRecord, ResourceRecord, ExecutionRecordHelper } from '@weiliang0121/capix-records';

import { readOutput, validateLegacyExecutionRecordSnapshot } from '@weiliang0121/capix-protocol';

const occurredAt = '2026-10-12T00:00:00.000Z';

function recordedFixture() {
  const book = new RecordBook();
  const prefixes = [];
  const recorder = new Recorder(book, { changes: { capture: () => prefixes.push(book.exportState()) } });
  const root = recorder.add(new RecordingRootRecord({ createdAt: occurredAt }));
  const runtime = recorder.add(new RuntimeCallRecord('r-context', 'r-instance', { input: null, startedAt: occurredAt }, root.id));
  const runtimeBoundary = (sequence, type) => recorder.add(new InvocationBoundaryRecord({ scopeId: runtime.id, callId: runtime.id, sequence, occurredAt, offsetMs: sequence - 1 }, { type }));
  runtimeBoundary(1, 'call');
  const execution = recorder.add(new ExecutionRecord('e-context', { input: { message: 'save' }, startedAt: occurredAt }, runtime.id));
  let sequence = 0;
  const boundary = (record, type) => recorder.add(new InvocationBoundaryRecord({ executionId: execution.id, callId: record.id, sequence: ++sequence, occurredAt, offsetMs: sequence - 1 }, { type }));
  boundary(execution, 'call');
  const operation = recorder.add(new OperationRecord({ contextId: 'o-context', executionId: execution.id, operationInstanceId: 'o-instance', operation: 'save', label: 'Save', source: 'fixture', caller: 'conversation', callee: 'save' }, { content: 'answer' }));
  boundary(operation, 'call');
  const attempt = recorder.add(new AttemptRecord({ contextId: 'a-context', operationId: operation.id, name: 'write', label: 'Write', source: 'fixture', caller: 'save', callee: 'write' }, { content: 'answer' }));
  boundary(attempt, 'call');
  const process = (entry, index) => recorder.update(attempt, (record) => record.append({ sequence: index, eventSequence: index, round: 1, occurredAt, offsetMs: index - 1, ...entry }));
  process({ stage: 'execute', type: 'start', input: { content: 'answer' } }, 1);
  process({ stage: 'execute', type: 'return', output: { written: true } }, 2);
  process({ stage: 'receive', type: 'return', resultOf: 2 }, 3);
  const resource = (phase, index) => recorder.add(new ResourceRecord({ parentId: attempt.id, access: 'files.write', supplyId: 'files', phase, sequence: index, occurredAt, ...(['started', 'returned'].includes(phase) ? { interactionId: 'write-1' } : {}) }, { path: 'summary.md' }));
  resource('bound', 1);
  resource('available', 2);
  resource('started', 3);
  resource('returned', 4);
  recorder.update(attempt, (record) => record.complete(undefined, 2));
  boundary(attempt, 'return');
  const failedAttempt = recorder.add(new AttemptRecord({ contextId: 'failed-context', operationId: operation.id, name: 'optional-check', label: 'Check', source: 'fixture', caller: 'save', callee: 'check' }, null));
  boundary(failedAttempt, 'call');
  recorder.update(failedAttempt, (record) => record.fail({ code: 'DECLARED_FAILURE', message: 'Unavailable', cause: { code: 'SOURCE', message: 'Source unavailable' } }, { kind: 'exception', contextId: failedAttempt.contextId, phase: 'execute', contract: 'unavailable' }));
  boundary(failedAttempt, 'throw');
  const source = { contextId: operation.contextId, callId: operation.id, executionId: execution.id, operationId: operation.id };
  recorder.add(new MemoryRecord({ memoryId: 'memory', memoriesId: 'memories', sequence: 1, source }, { action: 'create', change: 'Remember accepted answer', sourceIndexes: [0, 1], result: { topic: 'answer', content: 'saved', sourceIndexes: [0, 1] } }));
  recorder.add(new TranscriptRecord({ transcriptId: 'transcript', revision: 2, occurredAt, source: { contextId: execution.contextId, callId: execution.id, executionId: execution.id } }, { action: 'append', start: 1, end: 2 }));
  recorder.update(operation, (record) => record.complete({ written: true }));
  boundary(operation, 'return');
  const identity = { parentContextId: execution.contextId, childContextId: operation.contextId, parentRound: 1, key: 'save' };
  const relation = (change, eventSequence) => recorder.update(execution, (record) => record.appendRelation({ identity, childId: operation.id, change, eventSequence, occurredAt, offsetMs: eventSequence }));
  relation({ kind: 'attached' }, 1);
  relation({ kind: 'returned', result: { status: 'succeeded', output: { written: true } } }, 2);
  relation({ kind: 'receiving' }, 3);
  relation({ kind: 'accepted', output: { saved: true } }, 4);
  recorder.update(execution, (record) => record.complete({ saved: true }));
  boundary(execution, 'return');
  recorder.update(runtime, (record) => record.complete(null));
  runtimeBoundary(2, 'return');
  recorder.add(new TranscriptRecord({ transcriptId: 'transcript', revision: 3, occurredAt }, { action: 'segment', previousStart: 0, start: 1, end: 2 }));
  recorder.add(new BaseRecord({ custom: ['retained'] }));
  return { book, recorder, root, runtime, execution, operation, attempt, prefixes };
}

test('record history roundtrips concrete carriers, identities, local results and ownership without replay', () => {
  const original = recordedFixture();
  const state = JSON.parse(JSON.stringify(original.book.exportState()));
  const restored = RecordBook.restore(state);
  assert.deepEqual(restored.exportState(), original.book.exportState());
  for (const source of original.book.values()) {
    const record = restored.get(source.id);
    assert.ok(record instanceof (source.kind === 'custom' ? BaseRecord : source.constructor));
    assert.equal(record.historical, true);
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.value), true);
  }
  const changes = [];
  const recorder = new Recorder(restored, { changes: { capture: (event) => changes.push(event) } });
  assert.equal(recorder.revision, 0);
  assert.deepEqual(changes, []);
  assert.deepEqual(
    recorder.tree.descendants(original.root.id).map((record) => record.id),
    original.recorder.tree.descendants(original.root.id).map((record) => record.id),
  );
  assert.deepEqual(readOutput(restored.get(original.attempt.id).value), { written: true });
  validateLegacyExecutionRecordSnapshot(ExecutionRecordHelper.snapshot(recorder, original.execution.id));
  const freshRoot = recorder.add(new RecordingRootRecord({ createdAt: occurredAt }));
  assert.equal(freshRoot.historical, false);
  assert.equal(changes.length, 1);
  state.entries[0].data.value.createdAt = 'changed outside';
  assert.equal(restored.get(original.root.id).value.createdAt, occurredAt);
});

test('each genuine record publication prefix restores even before boundary or child reception is recorded', () => {
  for (const state of recordedFixture().prefixes) assert.deepEqual(RecordBook.restore(state).exportState(), state);
});

test('unfinished historical invocations cannot be completed, failed, extended or attached to', () => {
  const fixture = recordedFixture();
  const state = fixture.prefixes.find((snapshot) => snapshot.entries.some((entry) => entry.data.id === fixture.attempt.id && entry.data.value.processes.length === 1));
  const book = RecordBook.restore(state);
  const recorder = new Recorder(book);
  const attempt = book.get(fixture.attempt.id);
  assert.equal(attempt.status, 'running');
  assert.throws(() => attempt.complete({}), /read-only/);
  assert.throws(() => attempt.fail({ code: 'FAIL', message: 'no' }), /read-only/);
  assert.throws(() => attempt.append({}), /read-only/);
  assert.throws(() => attempt.appendRelation({}), /read-only/);
  let entered = false;
  assert.throws(
    () =>
      recorder.update(attempt, () => {
        entered = true;
      }),
    /read-only/,
  );
  assert.equal(entered, false);
  const child = new BaseRecord({}, fixture.root.id);
  assert.throws(() => recorder.add(child), /read-only/);
  assert.equal(book.get(child.id), undefined);
  assert.throws(() => new Recorder(new RecordBook()).add(attempt), /registered again/);
  assert.deepEqual(book.exportState(), state);
});

test('restoring rejects malformed identities, relations, invocation bodies and live contents', () => {
  const source = recordedFixture().book.exportState();
  const reject = (mutate) => {
    const state = structuredClone(source);
    mutate(state);
    assert.throws(() => RecordBook.restore(state));
  };
  reject((state) => state.entries.push(state.entries[0]));
  reject((state) => {
    state.entries[0].data.id = '';
  });
  reject((state) => {
    state.entries[0].data.childIds = [];
  });
  reject((state) => {
    state.entries[1].data.parentId = 'missing';
  });
  reject((state) => {
    state.entries[0].data.childIds.push('missing');
  });
  reject((state) => {
    state.entries.find((entry) => entry.kind === 'attempt').data.value.processes[0].sequence = 2;
  });
  reject((state) => {
    state.entries.find((entry) => entry.kind === 'attempt').data.value.resultOf = 1;
  });
  reject((state) => {
    state.entries.find((entry) => entry.kind === 'attempt').data.status = 'running';
  });
  reject((state) => {
    state.entries.find((entry) => entry.kind === 'operation').data.contextId = 'r-context';
  });
  reject((state) => {
    state.entries[0].data.value = { live: new Map() };
  });
  reject((state) => {
    state.entries[0].data.value = { function: () => {} };
  });
  reject((state) => {
    state.entries[0].data.value = state;
  });
});

test('restoring validates custom composite cycles and seals their child mutation path', () => {
  const book = new RecordBook();
  const recorder = new Recorder(book);
  const root = recorder.add(new CompositeRecord({ type: 'custom' }));
  const child = recorder.add(new CompositeRecord({}, root.id));
  const state = book.exportState();
  assert.deepEqual(RecordBook.restore(state).exportState(), state);
  const cycle = structuredClone(state);
  cycle.entries[0].data.parentId = child.id;
  cycle.entries[1].data.childIds = [root.id];
  assert.throws(() => RecordBook.restore(cycle), /ancestry/);
});

test('restoring rejects a child work boundary after its owning execution has ended', () => {
  const fixture = recordedFixture();
  const state = structuredClone(fixture.book.exportState());
  const boundaries = state.entries.filter((entry) => entry.kind === 'invocation-boundary' && entry.data.executionId === fixture.execution.id);
  const terminal = boundaries.find((entry) => entry.data.callId === fixture.execution.id && entry.data.value.type === 'return');
  const reordered = [boundaries[0], terminal, ...boundaries.slice(1).filter((entry) => entry !== terminal)];
  let index = 0;
  state.entries = state.entries.map((entry) => (entry.kind === 'invocation-boundary' && entry.data.executionId === fixture.execution.id ? reordered[index++] : entry));
  for (const [position, entry] of reordered.entries()) {
    entry.data.sequence = position + 1;
    entry.data.offsetMs = position;
  }
  assert.throws(() => RecordBook.restore(state), /outside its parent work/);
});
