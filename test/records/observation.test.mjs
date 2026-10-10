import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindRecording, bindInvocationObservation, invocationRecording, Recorder, RecordBook, ChangeBuffer, ResourceBindings, ExecutionRecordHelper, RuntimeCallRecord, defineObservation, InvocationRecordAccess } from '@capix/server-runtime';
import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';

function fixture(options) {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { changes });
  const recording = bindRecording(recorder, options);
  const create = (level, contextId, parent, description = {}) => {
    const declaration = invocationRecording({}, { failure: 'propagate' });
    const setup = { identity: { level, contextId, ...(parent ? { parentContextId: parent.setup.identity.contextId } : {}) }, description, resources: new ResourceBindings({}), declarations: [declaration] };
    const call = recording.bindInvocation(setup, parent);
    const observation = bindInvocationObservation({ ...setup, resources: call.resources }, []);
    let eventSequence = 0;
    return {
      call,
      publish(change, time) {
        const failure = observation.publish({ ...change, identity: setup.identity, description, eventSequence: ++eventSequence, occurredAt: '2026-10-09T00:00:00.000Z', monotonicTime: time });
        if (failure) throw failure;
      },
    };
  };
  return { changes, recorder, recording, create };
}
function completedPair() {
  const value = fixture();
  const runtime = value.create('runtime', 'r-context', undefined, { id: 'runtime-instance' });
  runtime.publish({ kind: 'started', input: null }, 10);
  runtime.publish({ kind: 'process', processSequence: 1, round: 1, process: { stage: 'execute', type: 'start', input: null } }, 11);
  const execution = value.create('execution', 'e-context', runtime.call);
  const relation = { parentContextId: 'r-context', childContextId: 'e-context', parentRound: 1, key: 'execution' };
  runtime.publish({ kind: 'relation', relation, change: { kind: 'attached' } }, 12);
  execution.publish({ kind: 'started', input: null }, 15);
  execution.publish({ kind: 'process', processSequence: 1, round: 1, process: { stage: 'execute', type: 'start', input: null } }, 16);
  execution.publish({ kind: 'process', processSequence: 2, round: 1, process: { stage: 'execute', type: 'return', output: 2 } }, 20);
  execution.publish({ kind: 'process', processSequence: 3, round: 1, process: { stage: 'receive', type: 'return', reuse: true } }, 21);
  execution.publish({ kind: 'finished', state: { status: 'succeeded', output: 2 } }, 22);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'returned', result: { status: 'succeeded', output: 2 } } }, 23);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'receiving' } }, 24);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'accepted', output: 4 } }, 25);
  runtime.publish({ kind: 'process', processSequence: 2, round: 1, process: { stage: 'execute', type: 'return', output: 4 } }, 26);
  runtime.publish({ kind: 'process', processSequence: 3, round: 1, process: { stage: 'receive', type: 'return', reuse: true } }, 27);
  runtime.publish({ kind: 'finished', state: { status: 'succeeded', output: 4 } }, 30);
  return { ...value, runtime, execution };
}

test('record preset keeps R invocation, E timing and parent reception distinct', () => {
  const { recorder, recording, runtime, execution, changes } = completedPair();
  const snapshot = ExecutionRecordHelper.snapshot(recorder, execution.call.record.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.ok(runtime.call.record instanceof RuntimeCallRecord);
  assert.equal(runtime.call.record.parentId, recording.root.id);
  assert.equal(snapshot.execution.parentId, runtime.call.record.id);
  assert.equal(snapshot.runtimeCall.runtimeInstanceId, 'runtime-instance');
  assert.deepEqual(
    snapshot.runtimeEvents.map((event) => event.offsetMs),
    [0, 20],
  );
  assert.ok(snapshot.runtimeEvents.every((event) => event.executionId === undefined && event.scopeId === runtime.call.record.id));
  assert.deepEqual(
    snapshot.events.map((event) => event.offsetMs),
    [0, 7],
  );
  assert.ok(snapshot.events.every((event) => event.scopeId === execution.call.record.id));
  const relation = snapshot.runtimeCall.value.relationChanges;
  assert.deepEqual(
    relation.map((entry) => entry.change.kind),
    ['attached', 'returned', 'receiving', 'accepted'],
  );
  assert.equal(relation[0].childId, undefined);
  assert.equal(relation[1].childId, snapshot.execution.id);
  assert.equal(relation[1].change.result.output, 2);
  assert.equal(relation[3].change.output, 4);
  assert.equal(readOutput(snapshot.runtimeCall.value), 4);
  assert.equal(readOutput(snapshot.execution.value), 2);
  assert.deepEqual(
    snapshot.runtimeCall.value.processes.map((process) => process.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    snapshot.runtimeCall.value.processes.map((process) => process.eventSequence),
    [2, 7, 8],
  );
  const appended = changes.take().filter((event) => event.change.kind === 'relation-appended');
  assert.equal(appended.length, 4);
  assert.ok(appended.every((event) => event.change.id === snapshot.runtimeCall.id));
});

test('record relation snapshots reject acceptance before return and duplicate event sequence', () => {
  const { recorder, execution } = completedPair();
  const snapshot = ExecutionRecordHelper.snapshot(recorder, execution.call.record.id);
  const invalid = structuredClone(snapshot);
  invalid.runtimeCall.value.relationChanges.splice(1, 1);
  assert.throws(() => validateExecutionRecordSnapshot(invalid));
  const duplicate = structuredClone(snapshot);
  duplicate.runtimeCall.value.relationChanges[0].eventSequence = duplicate.runtimeCall.value.processes[0].eventSequence;
  assert.throws(() => validateExecutionRecordSnapshot(duplicate));
});

test('execution snapshots require their actual Runtime call and its independent boundary facts', () => {
  const { recorder, execution } = completedPair();
  const snapshot = ExecutionRecordHelper.snapshot(recorder, execution.call.record.id);
  for (const field of ['runtimeCall', 'runtimeEvents']) {
    const missing = structuredClone(snapshot);
    delete missing[field];
    assert.throws(() => validateExecutionRecordSnapshot(missing));
  }
  const unrelated = structuredClone(snapshot);
  unrelated.execution.parentId = 'another-runtime-call';
  assert.throws(() => validateExecutionRecordSnapshot(unrelated));
  const wrongScope = structuredClone(snapshot);
  wrongScope.runtimeEvents[0].scopeId = snapshot.execution.id;
  assert.throws(() => validateExecutionRecordSnapshot(wrongScope));
});

test('preconstructed child attachments retain their fact order when the parent recording starts', () => {
  const { create, recorder } = fixture();
  const parent = create('runtime', 'r', undefined, { id: 'runtime' });
  const child = create('execution', 'e', parent.call);
  const relation = { parentContextId: 'r', childContextId: 'e', parentRound: 0, key: 'prepared' };
  parent.publish({ kind: 'relation', relation, change: { kind: 'attached' } }, 1);
  assert.equal(parent.call.record, undefined);
  relation.key = 'mutated after publication';
  parent.publish({ kind: 'started', input: null }, 10);
  const attached = parent.call.record.value.relationChanges[0];
  assert.equal(attached.eventSequence, 1);
  assert.equal(attached.identity.key, 'prepared');
  assert.equal(attached.offsetMs, 0);
  child.publish({ kind: 'started', input: null }, 12);
  child.publish({ kind: 'finished', state: { status: 'succeeded', output: 'done' } }, 13);
  parent.publish({ kind: 'relation', relation: { ...relation, key: 'prepared' }, change: { kind: 'returned', result: { status: 'succeeded', output: 'done' } } }, 14);
  parent.publish({ kind: 'finished', state: { status: 'succeeded', output: 'done' } }, 15);
  validateExecutionRecordSnapshot(ExecutionRecordHelper.snapshot(recorder, child.call.record.id));
});

test('record installation supplies a scoped writer, not an automatic second call-record path', () => {
  const { recording } = fixture();
  const scope = recording.bindInvocation({ identity: { level: 'runtime', contextId: 'r' }, description: { id: 'runtime' }, resources: new ResourceBindings({}), declarations: [invocationRecording()] });
  const fact = { kind: 'started', input: null, identity: scope.setup.identity, description: scope.setup.description, eventSequence: 1, occurredAt: '2026-10-09T00:00:00.000Z', monotonicTime: 0 };
  scope.observe(fact);
  assert.equal(scope.record, undefined);
  let writer;
  const declaration = defineObservation(
    {
      requires: { writer: InvocationRecordAccess.request() },
      observe(event, ports) {
        writer = ports.writer;
        writer.observe(event);
      },
    },
    { failure: 'propagate' },
  );
  const observation = bindInvocationObservation({ ...scope.setup, resources: scope.resources, declarations: [declaration] }, []);
  assert.equal(observation.publish(fact), undefined);
  assert.ok(scope.record);
  assert.throws(() => writer.observe(fact), /window has ended/);
});

test('failed scoped recording disables dependent children while later calls retain independent state', () => {
  const failures = [];
  const { create, recording } = fixture({ invalidate: (error) => failures.push(error) });
  const broken = create('runtime', 'broken', undefined, { id: 'runtime' });
  assert.throws(() => broken.publish({ kind: 'started', input: () => {} }, 1));
  assert.equal(broken.call.available(), false);
  const child = create('execution', 'child', broken.call);
  assert.equal(child.call.available(), false);
  child.publish({ kind: 'started', input: null }, 2);
  assert.equal(child.call.record, undefined);
  const good = create('runtime', 'good', undefined, { id: 'runtime' });
  good.publish({ kind: 'started', input: null }, 3);
  assert.equal(good.call.available(), true);
  assert.ok(good.call.record);
  assert.equal(failures.length, 1);
  assert.equal(recording.root.childIds.length, 1);
});
